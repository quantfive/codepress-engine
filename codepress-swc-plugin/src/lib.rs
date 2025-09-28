use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use swc_core::common::{FileName, SourceMapper, DUMMY_SP};
use swc_core::ecma::{
    ast::*,
    parser::{EsSyntax, Parser, StringInput, Syntax},
    visit::{VisitMut, VisitMutWith},
};
use swc_core::plugin::{plugin_transform, proxies::TransformPluginProgramMetadata};

// Global flag to ensure repo/branch attributes are added only once
static GLOBAL_ATTRIBUTES_ADDED: AtomicBool = AtomicBool::new(false);

/// XOR encodes a string with a multi-byte rotating key (same as Babel plugin)
fn xor_encode(input: &str) -> String {
    const SECRET: &[u8] = b"codepress-file-obfuscation";
    let xored: Vec<u8> = input.bytes().enumerate().map(|(i, b)| b ^ SECRET[i % SECRET.len()]).collect();
    let base64_encoded = STANDARD.encode(xored);
    base64_encoded
        .replace('+', "-")
        .replace('/', "_")
        .replace('=', "")
}

#[derive(Debug, Serialize, Clone)]
struct DiscoveredComponent {
    export_name: String,
    display_name: String,
    kind: String,
    is_default: bool,
}

#[derive(Debug, Serialize, Clone)]
struct ModuleRegistration {
    file_path: String,
    repo_name: Option<String>,
    branch_name: Option<String>,
    components: Vec<DiscoveredComponent>,
}

pub struct CodePressTransform {
    repo_name: Option<String>,
    branch_name: Option<String>,
    source_map: Option<std::sync::Arc<dyn SourceMapper>>,
    runtime_registration: bool,
    runtime_global: String,
    registration_flush_callback: Option<String>,
    pending_module_components: Vec<DiscoveredComponent>,
    skip_registration_for_module: bool,
}

/// Normalizes incoming filenames from bundlers (e.g., Turbopack) before encoding
/// - Converts backslashes to forward slashes
/// - Strips a leading "[project]/" prefix if present (Turbopack virtual paths)
fn normalize_filename(filename: &str) -> String {
    // 1) Posix-ify
    let mut s = filename.replace('\\', "/");

    // 2) De-URL-encode the common bracket encoding if present
    // Support both uppercase and lowercase percent-encoding
    s = s.replace("%5Bproject%5D", "[project]");
    s = s.replace("%5bproject%5d", "[project]");

    // 3) Strip an optional 'file://', 'file:///' prefix used by some debuggers
    if let Some(rest) = s.strip_prefix("file:///") {
        s = rest.to_string();
    } else if let Some(rest) = s.strip_prefix("file://") {
        s = rest.to_string();
    }

    // 4) Strip Turbopack's virtual prefix variants
    for prefix in &["turbopack/[project]/", "/turbopack/[project]/", "[project]/"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            return rest.to_string();
        }
    }

    s
}

impl CodePressTransform {
    pub fn new(config: HashMap<String, serde_json::Value>, source_map: Option<std::sync::Arc<dyn SourceMapper>>) -> Self {
        let repo_name = config
            .get("repo_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let branch_name = config
            .get("branch_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let runtime_registration = config
            .get("runtime_registration")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        let runtime_global = config
            .get("runtime_global")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "__CODEPRESS_COMPONENT_REGISTRATIONS__".to_string());

        let registration_flush_callback = config
            .get("runtime_flush_callback")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        Self {
            repo_name,
            branch_name,
            source_map,
            runtime_registration,
            runtime_global,
            registration_flush_callback,
            pending_module_components: Vec::new(),
            skip_registration_for_module: false,
        }
    }

    fn get_line_info(&self, opening_span: swc_core::common::Span, parent_span: Option<swc_core::common::Span>) -> Option<String> {
        if let Some(ref cm) = self.source_map {
            let start_loc = cm.lookup_char_pos(opening_span.lo());
            
            // Use parent span (entire JSX element) for end line if available, otherwise use opening span
            let end_span = parent_span.unwrap_or(opening_span);
            let end_loc = cm.lookup_char_pos(end_span.hi());
            
            Some(format!("{}-{}", start_loc.line, end_loc.line))
        } else {
            None
        }
    }

    fn create_encoded_path_attr(&self, filename: &str, opening_span: swc_core::common::Span, parent_span: Option<swc_core::common::Span>) -> JSXAttrOrSpread {
        let normalized = normalize_filename(filename);
        let encoded_path = xor_encode(&normalized);
        
        let attr_value = if let Some(line_info) = self.get_line_info(opening_span, parent_span) {
            format!("{}:{}", encoded_path, line_info)
        } else {
            encoded_path
        };

        JSXAttrOrSpread::JSXAttr(JSXAttr {
            span: DUMMY_SP,
            name: JSXAttrName::Ident(IdentName::new("codepress-data-fp".into(), DUMMY_SP)),
            value: Some(JSXAttrValue::Lit(Lit::Str(Str {
                span: DUMMY_SP,
                value: attr_value.into(),
                raw: None,
            }))),
        })
    }

    fn create_repo_attr(&self) -> Option<JSXAttrOrSpread> {
        self.repo_name.as_ref().map(|repo| {
            JSXAttrOrSpread::JSXAttr(JSXAttr {
                span: DUMMY_SP,
                name: JSXAttrName::Ident(IdentName::new("codepress-github-repo-name".into(), DUMMY_SP)),
                value: Some(JSXAttrValue::Lit(Lit::Str(Str {
                    span: DUMMY_SP,
                    value: repo.clone().into(),
                    raw: None,
                }))),
            })
        })
    }

    fn create_branch_attr(&self) -> Option<JSXAttrOrSpread> {
        self.branch_name.as_ref().map(|branch| {
            JSXAttrOrSpread::JSXAttr(JSXAttr {
                span: DUMMY_SP,
                name: JSXAttrName::Ident(IdentName::new("codepress-github-branch".into(), DUMMY_SP)),
                value: Some(JSXAttrValue::Lit(Lit::Str(Str {
                    span: DUMMY_SP,
                    value: branch.clone().into(),
                    raw: None,
                }))),
            })
        })
    }

    fn is_suitable_root_element(&self, element_name: &str) -> bool {
        // Target html, body, or div as potential root elements (same as Babel plugin)
        matches!(element_name, "html" | "body" | "div")
    }

    fn has_repo_attribute(&self, attrs: &[JSXAttrOrSpread]) -> bool {
        attrs.iter().any(|attr| {
            if let JSXAttrOrSpread::JSXAttr(jsx_attr) = attr {
                if let JSXAttrName::Ident(ident) = &jsx_attr.name {
                    return ident.sym.as_ref() == "codepress-github-repo-name";
                }
            }
            false
        })
    }

    fn has_branch_attribute(&self, attrs: &[JSXAttrOrSpread]) -> bool {
        attrs.iter().any(|attr| {
            if let JSXAttrOrSpread::JSXAttr(jsx_attr) = attr {
                if let JSXAttrName::Ident(ident) = &jsx_attr.name {
                    return ident.sym.as_ref() == "codepress-github-branch";
                }
            }
            false
        })
    }
}

impl VisitMut for CodePressTransform {
    fn visit_mut_module(&mut self, module: &mut Module) {
        self.skip_registration_for_module = self.should_skip_module(module);
        // Collect exported components for this module before mutation
        self.collect_exported_components(module);

        // Continue traversing for JSX transformations
        module.visit_mut_children_with(self);

        if self.runtime_registration
            && !self.skip_registration_for_module
            && !self.pending_module_components.is_empty()
        {
            let registration = self.build_module_registration(module);
            if let Some(mut items) = self.create_runtime_registration_stmt(&registration) {
                module.body.append(&mut items);
            }
        }

        // Clear collected components for next module
        self.pending_module_components.clear();
    }

    fn visit_mut_jsx_element(&mut self, node: &mut JSXElement) {
        // Get the filename from the span's source file
        let filename = if let Some(ref cm) = self.source_map {
            let loc = cm.lookup_char_pos(node.span.lo());
            loc.file.name.to_string()
        } else {
            "unknown".to_string()
        };

        // Always add encoded file path attribute to every JSX element
        // Use the opening element's span for start line and the full element's span for end line
        node.opening.attrs.push(self.create_encoded_path_attr(&filename, node.opening.span, Some(node.span)));

        // Add repo and branch attributes only once globally to a suitable root element
        if self.repo_name.is_some() && !GLOBAL_ATTRIBUTES_ADDED.load(Ordering::Relaxed) {
            // Check if this is a suitable root element
            let element_name = match &node.opening.name {
                JSXElementName::Ident(ident) => ident.sym.as_ref(),
                _ => "",
            };

            if self.is_suitable_root_element(element_name) {
                // Add repo attribute if it doesn't already exist
                if !self.has_repo_attribute(&node.opening.attrs) {
                    if let Some(repo_attr) = self.create_repo_attr() {
                        node.opening.attrs.push(repo_attr);
                    }
                }

                // Add branch attribute if it doesn't already exist
                if !self.has_branch_attribute(&node.opening.attrs) {
                    if let Some(branch_attr) = self.create_branch_attr() {
                        node.opening.attrs.push(branch_attr);
                    }
                }

                // Mark that we've added attributes globally
                GLOBAL_ATTRIBUTES_ADDED.store(true, Ordering::Relaxed);
            }
        }

        // Continue visiting child nodes
        node.visit_mut_children_with(self);
    }
}

impl CodePressTransform {
    fn module_export_name_to_string(name: &ModuleExportName) -> Option<String> {
        match name {
            ModuleExportName::Ident(ident) => Some(ident.sym.to_string()),
            ModuleExportName::Str(str_lit) => Some(str_lit.value.to_string()),
        }
    }

    fn collect_exported_components(&mut self, module: &Module) {
        self.pending_module_components.clear();

        if self.skip_registration_for_module {
            return;
        }

        for item in &module.body {
            match item {
                ModuleItem::ModuleDecl(decl) => match decl {
                    ModuleDecl::ExportDecl(export_decl) => {
                        self.handle_export_decl(export_decl);
                    }
                    ModuleDecl::ExportDefaultDecl(default_decl) => {
                        self.handle_default_decl(default_decl);
                    }
                    ModuleDecl::ExportDefaultExpr(default_expr) => {
                        self.handle_default_expr(default_expr);
                    }
                    ModuleDecl::ExportNamed(export_named) => {
                        self.handle_named_export(export_named);
                    }
                    _ => {}
                },
                _ => {}
            }
        }
    }

    fn handle_export_decl(&mut self, export_decl: &ExportDecl) {
        match &export_decl.decl {
            Decl::Fn(fn_decl) => {
                let ident = &fn_decl.ident;
                if self.looks_like_component_str(ident.sym.as_ref()) {
                    self.pending_module_components.push(DiscoveredComponent {
                        export_name: ident.sym.to_string(),
                        display_name: ident.sym.to_string(),
                        kind: "function".to_string(),
                        is_default: false,
                    });
                }
            }
            Decl::Class(class_decl) => {
                let ident = &class_decl.ident;
                if self.looks_like_component_str(ident.sym.as_ref()) {
                    self.pending_module_components.push(DiscoveredComponent {
                        export_name: ident.sym.to_string(),
                        display_name: ident.sym.to_string(),
                        kind: "class".to_string(),
                        is_default: false,
                    });
                }
            }
            Decl::Var(var_decl) => {
                for declarator in &var_decl.decls {
                    if let Pat::Ident(binding_ident) = &declarator.name {
                        let ident = &binding_ident.id.sym;
                        if !self.looks_like_component_str(ident.as_ref()) {
                            continue;
                        }

                        if let Some(init_expr) = &declarator.init {
                            if Self::is_component_expression(init_expr) {
                                self.pending_module_components.push(DiscoveredComponent {
                                    export_name: ident.to_string(),
                                    display_name: ident.to_string(),
                                    kind: Self::expression_kind(init_expr.as_ref()),
                                    is_default: false,
                                });
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn handle_default_decl(&mut self, default_decl: &ExportDefaultDecl) {
        match &default_decl.decl {
            DefaultDecl::Fn(fn_expr) => {
                let display_name = fn_expr
                    .ident
                    .as_ref()
                    .map(|ident| ident.sym.to_string())
                    .unwrap_or_else(|| "DefaultComponent".to_string());
                if fn_expr
                    .ident
                    .as_ref()
                    .map(|ident| self.looks_like_component_str(ident.sym.as_ref()))
                    .unwrap_or(true)
                {
                    self.pending_module_components.push(DiscoveredComponent {
                        export_name: "default".to_string(),
                        display_name,
                        kind: "function".to_string(),
                        is_default: true,
                    });
                }
            }
            DefaultDecl::Class(class_expr) => {
                let display_name = class_expr
                    .ident
                    .as_ref()
                    .map(|ident| ident.sym.to_string())
                    .unwrap_or_else(|| "DefaultComponent".to_string());
                if class_expr
                    .ident
                    .as_ref()
                    .map(|ident| self.looks_like_component_str(ident.sym.as_ref()))
                    .unwrap_or(true)
                {
                    self.pending_module_components.push(DiscoveredComponent {
                        export_name: "default".to_string(),
                        display_name,
                        kind: "class".to_string(),
                        is_default: true,
                    });
                }
            }
            DefaultDecl::TsInterfaceDecl(_) => {}
        }
    }

    fn handle_default_expr(&mut self, default_expr: &ExportDefaultExpr) {
        match &*default_expr.expr {
            Expr::Ident(ident) => {
                if self.looks_like_component_str(ident.sym.as_ref()) {
                    self.pending_module_components.push(DiscoveredComponent {
                        export_name: "default".to_string(),
                        display_name: ident.sym.to_string(),
                        kind: "reference".to_string(),
                        is_default: true,
                    });
                }
            }
            Expr::Fn(_) | Expr::Arrow(_) | Expr::Class(_) => {
                self.pending_module_components.push(DiscoveredComponent {
                    export_name: "default".to_string(),
                    display_name: "DefaultComponent".to_string(),
                    kind: Self::expression_kind(default_expr.expr.as_ref()),
                    is_default: true,
                });
            }
            Expr::Call(call_expr) => {
                if let Some(display_ident) = Self::extract_display_name_from_call(call_expr) {
                    self.pending_module_components.push(DiscoveredComponent {
                        export_name: "default".to_string(),
                        display_name: display_ident,
                        kind: "wrapped".to_string(),
                        is_default: true,
                    });
                } else {
                    self.pending_module_components.push(DiscoveredComponent {
                        export_name: "default".to_string(),
                        display_name: "DefaultComponent".to_string(),
                        kind: "wrapped".to_string(),
                        is_default: true,
                    });
                }
            }
            _ => {}
        }
    }

    fn handle_named_export(&mut self, export_named: &NamedExport) {
        for specifier in &export_named.specifiers {
            match specifier {
                ExportSpecifier::Named(named_specifier) => {
                    let exported = named_specifier
                        .exported
                        .as_ref()
                        .and_then(Self::module_export_name_to_string)
                        .or_else(|| Self::module_export_name_to_string(&named_specifier.orig));

                    if let Some(export_name) = exported {
                        if self.looks_like_component_str(&export_name) {
                            self.pending_module_components.push(DiscoveredComponent {
                                export_name: export_name.clone(),
                                display_name: export_name,
                                kind: "re-export".to_string(),
                                is_default: false,
                            });
                        }
                    }
                }
                ExportSpecifier::Default(default_specifier) => {
                    let export_name = default_specifier.exported.sym.to_string();
                    if self.looks_like_component_str(default_specifier.exported.sym.as_ref()) {
                        self.pending_module_components.push(DiscoveredComponent {
                            export_name,
                            display_name: default_specifier.exported.sym.to_string(),
                            kind: "re-export".to_string(),
                            is_default: false,
                        });
                    }
                }
                ExportSpecifier::Namespace(namespace_specifier) => {
                    if let Some(exported) =
                        Self::module_export_name_to_string(&namespace_specifier.name)
                    {
                        if self.looks_like_component_str(&exported) {
                            self.pending_module_components.push(DiscoveredComponent {
                                export_name: exported.clone(),
                                display_name: exported,
                                kind: "namespace".to_string(),
                                is_default: false,
                            });
                        }
                    }
                }
            }
        }
    }

    fn looks_like_component_str(&self, candidate: &str) -> bool {
        let first = candidate.chars().next().unwrap_or('a');
        first.is_uppercase()
    }

    fn is_component_expression(expr: &Box<Expr>) -> bool {
        matches!(expr.as_ref(), Expr::Arrow(_) | Expr::Fn(_) | Expr::Class(_))
            || Self::extract_display_name_from_call_expr(expr).is_some()
    }

    fn expression_kind(expr: &Expr) -> String {
        match expr {
            Expr::Arrow(_) => "arrow".to_string(),
            Expr::Fn(_) => "function".to_string(),
            Expr::Class(_) => "class".to_string(),
            _ => "expression".to_string(),
        }
    }

    fn extract_display_name_from_call_expr(expr: &Box<Expr>) -> Option<String> {
        if let Expr::Call(call_expr) = expr.as_ref() {
            Self::extract_display_name_from_call(call_expr)
        } else {
            None
        }
    }

    fn extract_display_name_from_call(call_expr: &CallExpr) -> Option<String> {
        // Look for forwardRef(() => <Component />) or memo(Component)
        if let Some(arg) = call_expr.args.get(0) {
            match &*arg.expr {
                Expr::Ident(ident) => {
                    if ident.sym.as_ref().chars().next().map(|c| c.is_uppercase()).unwrap_or(false) {
                        return Some(ident.sym.to_string());
                    }
                }
                Expr::Fn(fn_expr) => {
                    if let Some(ident) = &fn_expr.ident {
                        if ident.sym.as_ref().chars().next().map(|c| c.is_uppercase()).unwrap_or(false) {
                            return Some(ident.sym.to_string());
                        }
                    }
                }
                Expr::Arrow(_) => {
                    if let Callee::Expr(expr) = &call_expr.callee {
                        if let Expr::Ident(callee_ident) = &**expr {
                            return Some(format!("{}Wrapped", callee_ident.sym));
                        }
                    }
                }
                _ => {}
            }
        }
        None
    }

    fn build_module_registration(&self, module: &Module) -> ModuleRegistration {
        let file_path = if let Some(ref cm) = self.source_map {
            let loc = cm.lookup_char_pos(module.span.lo());
            match &*loc.file.name {
                FileName::Custom(name) => name.clone(),
                FileName::Real(path_buf) => path_buf.to_string_lossy().into_owned(),
                FileName::Anon => "unknown".to_string(),
                FileName::Url(url) => url.to_string(),
                _ => "unknown".to_string(),
            }
        } else {
            "unknown".to_string()
        };

        ModuleRegistration {
            file_path: normalize_filename(&file_path),
            repo_name: self.repo_name.clone(),
            branch_name: self.branch_name.clone(),
            components: self.pending_module_components.clone(),
        }
    }

    fn create_runtime_registration_stmt(
        &self,
        registration: &ModuleRegistration,
    ) -> Option<Vec<ModuleItem>> {
        if self.skip_registration_for_module {
            return None;
        }

        let components_value = match serde_json::to_value(&registration.components) {
            Ok(value) => value,
            Err(_) => return None,
        };

        let registration_literal = json!({
            "filePath": registration.file_path,
            "repoName": registration.repo_name,
            "branchName": registration.branch_name,
            "components": components_value,
            "moduleInfo": serde_json::Value::Null,
        });

        let registration_json = registration_literal.to_string();

        let flush_callback = self
            .registration_flush_callback
            .as_ref()
            .map(|name| format!(
                "if (typeof globalThis.{name} === \"function\") {{ globalThis.{name}(__cpReg); }}"
            ))
            .unwrap_or_default();

        let mut injected_code = String::new();
        injected_code.push_str(&format!(
            "const __cpReg = {registration_json};\n",
        ));
        injected_code.push_str(
            "const __moduleInfo = (() => {\n  let loader = null;\n  let moduleId = null;\n  let chunkIds = null;\n  let importMetaUrl = null;\n  try {\n    if (typeof __webpack_require__ !== 'undefined') {\n      loader = 'webpack';\n    } else if (typeof globalThis !== 'undefined' && (globalThis.__turbopack_load__ || globalThis.__turbopack_import__ || globalThis.__next_require__)) {\n      loader = 'next';\n    }\n  } catch (err) {}\n  try {\n    if (typeof module !== 'undefined') {\n      if (module && typeof module.id !== 'undefined') {\n        moduleId = module.id;\n      } else if (module && typeof module.i !== 'undefined') {\n        moduleId = module.i;\n      }\n      if (module && typeof module.ids !== 'undefined') {\n        chunkIds = Array.isArray(module.ids) ? module.ids.slice() : [module.ids];\n      }\n    }\n  } catch (err) {}\n  try {\n    if (typeof import.meta !== 'undefined' && import.meta && import.meta.url) {\n      importMetaUrl = import.meta.url;\n      if (!moduleId) {\n        moduleId = import.meta.url;\n      }\n      if (!loader) {\n        loader = 'esm';\n      }\n    }\n  } catch (err) {}\n  try {\n    if (!moduleId && typeof globalThis !== 'undefined' && globalThis.__next_require__) {\n      const nextReq = globalThis.__next_require__;\n      const candidates = Object.keys((nextReq && (nextReq.m || nextReq.modules)) || {});\n      const target = (__cpReg.filePath || '').toLowerCase();\n      if (target && candidates.length) {\n        const match = candidates.find((key) => {\n          const lower = (key || '').toLowerCase();\n          return lower === target || lower.endsWith(target) || lower.includes(target);\n        });\n        if (match) {\n          moduleId = match;\n        }\n      }\n      if (!loader && moduleId) {\n        loader = 'next';\n      }\n    }\n  } catch (err) {}\n  if (!loader && moduleId) {\n    loader = 'module';\n  }\n  return { loader, moduleId, chunkIds, importMetaUrl };\n})();\n"
        );
        injected_code.push_str(
            "__cpReg.moduleInfo = __moduleInfo;\nif (Array.isArray(__cpReg.components)) {\n  __cpReg.components = __cpReg.components.map((comp) => {\n    const exportName = comp.exportName || comp.export_name || comp.spec || 'default';\n    return Object.assign({}, comp, { runtime: Object.assign({}, comp.runtime || {}, { loader: __moduleInfo.loader, moduleId: __moduleInfo.moduleId, chunkIds: __moduleInfo.chunkIds, importMetaUrl: __moduleInfo.importMetaUrl, exportName }) });\n  });\n}\n"
        );
        write!(
            &mut injected_code,
            "if (typeof globalThis !== \"undefined\") {{\n  const __target = (globalThis.{global} = globalThis.{global} || []);\n  const existingIndex = __target.findIndex((item) => item.filePath === __cpReg.filePath);\n  if (existingIndex >= 0) {{\n    __target[existingIndex] = __cpReg;\n  }} else {{\n    __target.push(__cpReg);\n  }}\n  {flush}\n}}\n",
            global = self.runtime_global,
            flush = flush_callback
        ).ok();

        Some(parse_module_items(&injected_code))
    }

    fn should_skip_module(&self, module: &Module) -> bool {
        if let Some(ref cm) = self.source_map {
            let loc = cm.lookup_char_pos(module.span.lo());
            let raw = match &*loc.file.name {
                FileName::Custom(name) => name.clone(),
                FileName::Real(path_buf) => path_buf.to_string_lossy().into_owned(),
                _ => String::new(),
            };
            let normalized = normalize_filename(&raw);
            return Self::should_skip_module_path(&normalized);
        }
        false
    }

    fn should_skip_module_path(path: &str) -> bool {
        if path.is_empty() {
            return false;
        }

        let lower = path.to_lowercase();
        lower.contains("node_modules/next/")
            || lower.contains("node_modules\\next\\")
            || lower.contains("/.next/")
            || lower.contains("\\.next\\")
    }
}

fn parse_module_items(code: &str) -> Vec<ModuleItem> {
    use swc_core::common::sync::Lrc;
    let cm: Lrc<swc_core::common::SourceMap> = Lrc::default();
    let fm = cm.new_source_file(
        FileName::Custom("codepress_injected.js".into()).into(),
        code.into(),
    );
    let mut parser = Parser::new(
        Syntax::Es(EsSyntax {
            jsx: true,
            ..Default::default()
        }),
        StringInput::from(&*fm),
        None,
    );
    match parser.parse_module() {
        Ok(module) => module.body,
        Err(_) => vec![],
    }
}

#[plugin_transform]
pub fn process_transform(mut program: Program, metadata: TransformPluginProgramMetadata) -> Program {
    let config = metadata
        .get_transform_plugin_config()
        .map(|s| serde_json::from_str(&s).unwrap_or_default())
        .unwrap_or_default();

    // Convert PluginSourceMapProxy to Arc<dyn SourceMapper>
    let source_map: Option<std::sync::Arc<dyn SourceMapper>> = Some(std::sync::Arc::new(metadata.source_map));

    GLOBAL_ATTRIBUTES_ADDED.store(false, Ordering::Relaxed);

    let mut transform = CodePressTransform::new(config, source_map);
    program.visit_mut_with(&mut transform);
    program
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_xor_encode() {
        let input = "test";
        let encoded = xor_encode(input);
        assert!(!encoded.is_empty());
        assert!(!encoded.contains('+'));
        assert!(!encoded.contains('/'));
        assert!(!encoded.contains('='));
    }

    #[test]
    fn test_transform_creation() {
        let config = HashMap::new();
        let transform = CodePressTransform::new(config, None);
        // Should not panic
        assert!(transform.repo_name.is_none());
        assert!(transform.branch_name.is_none());
    }

    #[test]
    fn test_config_override() {
        let mut config = HashMap::new();
        config.insert("repo_name".to_string(), serde_json::Value::String("test/repo".to_string()));
        config.insert("branch_name".to_string(), serde_json::Value::String("test-branch".to_string()));
        
        let transform = CodePressTransform::new(config, None);
        assert_eq!(transform.repo_name, Some("test/repo".to_string()));
        assert_eq!(transform.branch_name, Some("test-branch".to_string()));
    }

    #[test]
    fn test_suitable_root_elements() {
        let config = HashMap::new();
        let transform = CodePressTransform::new(config, None);
        
        assert!(transform.is_suitable_root_element("html"));
        assert!(transform.is_suitable_root_element("body"));
        assert!(transform.is_suitable_root_element("div"));
        assert!(!transform.is_suitable_root_element("span"));
        assert!(!transform.is_suitable_root_element("p"));
    }
} 
