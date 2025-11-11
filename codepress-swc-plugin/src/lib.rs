use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use swc_core::{
    common::{SourceMapper, Spanned, SyntaxContext, DUMMY_SP}, // SyntaxContext isn't used in 0.87
    ecma::{
        ast::{Id, *}, // don't import Ident and IdentName use compat functions
        visit::{Visit, VisitMut, VisitMutWith, VisitWith},
    },
    plugin::{plugin_transform, proxies::TransformPluginProgramMetadata},
};

// ---------- Compatibility helpers (per-swccore band) ----------

// Ident::new signature differs: (JsWord, Span) on 0.82–0.87; (JsWord, Span, SyntaxContext) on newer
#[cfg(feature = "compat_0_87")]
#[inline]
fn cp_ident(sym: &str) -> Ident {
    Ident::new(sym.into(), DUMMY_SP)
}

#[cfg(not(feature = "compat_0_87"))]
#[inline]
fn cp_ident(sym: &str) -> Ident {
    Ident::new(sym.into(), DUMMY_SP, SyntaxContext::empty())
}

// IdentName type does not exist on 0.82–0.87; JSX APIs accept Ident directly.
// On newer bands, we need IdentName.
#[cfg(feature = "compat_0_87")]
type CpIdentName = Ident;

#[cfg(not(feature = "compat_0_87"))]
type CpIdentName = swc_core::ecma::ast::IdentName;

#[cfg(feature = "compat_0_87")]
#[inline]
fn cp_ident_name(sym: &str) -> CpIdentName {
    Ident::new(sym.into(), DUMMY_SP)
}

#[cfg(not(feature = "compat_0_87"))]
#[inline]
fn cp_ident_name(sym: &str) -> CpIdentName {
    swc_core::ecma::ast::IdentName::new(sym.into(), DUMMY_SP)
}

#[cfg(feature = "compat_0_87")]
fn make_assign_left_member(obj: Expr, prop: CpIdentName) -> swc_core::ecma::ast::PatOrExpr {
    use swc_core::ecma::ast::{MemberExpr, MemberProp, PatOrExpr};
    // older band: left is PatOrExpr (usually PatOrExpr::Expr(Box<Expr>))
    PatOrExpr::Expr(Box::new(Expr::Member(MemberExpr {
        span: DUMMY_SP,
        obj: Box::new(obj),
        prop: MemberProp::Ident(prop),
    })))
}

#[cfg(not(feature = "compat_0_87"))]
fn make_assign_left_member(obj: Expr, prop: CpIdentName) -> swc_core::ecma::ast::AssignTarget {
    use swc_core::ecma::ast::{AssignTarget, MemberExpr, MemberProp, SimpleAssignTarget};
    // newer band: left is AssignTarget
    AssignTarget::Simple(SimpleAssignTarget::Member(MemberExpr {
        span: DUMMY_SP,
        obj: Box::new(obj),
        prop: MemberProp::Ident(prop),
    }))
}

// End Compatibility helpers // TODO: move these to another file?

// -----------------------------------------------------------------------------
// Globals
// -----------------------------------------------------------------------------

static GLOBAL_ATTRIBUTES_ADDED: AtomicBool = AtomicBool::new(false);

// -----------------------------------------------------------------------------
// Encoding & filename helpers
// -----------------------------------------------------------------------------

fn xor_encode(input: &str) -> String {
    const SECRET: &[u8] = b"codepress-file-obfuscation";
    let xored: Vec<u8> = input
        .bytes()
        .enumerate()
        .map(|(i, b)| b ^ SECRET[i % SECRET.len()])
        .collect();
    URL_SAFE_NO_PAD.encode(xored)
    // input.to_string()
}

/// Normalize bundler/debugger style filenames before encoding.
fn normalize_filename(filename: &str) -> String {
    let mut s = filename.replace('\\', "/");
    s = s.replace("%5Bproject%5D", "[project]");
    s = s.replace("%5bproject%5d", "[project]");
    if let Some(rest) = s.strip_prefix("file:///") {
        s = rest.to_string();
    } else if let Some(rest) = s.strip_prefix("file://") {
        s = rest.to_string();
    }
    for prefix in &[
        "turbopack/[project]/",
        "/turbopack/[project]/",
        "[project]/",
    ] {
        if let Some(rest) = s.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    s
}

// -----------------------------------------------------------------------------
// Transform state
// -----------------------------------------------------------------------------

pub struct CodePressTransform {
    repo_name: Option<String>,
    branch_name: Option<String>,
    source_map: Option<std::sync::Arc<dyn SourceMapper>>,

    // Provenance helpers
    bindings: HashMap<Id, Binding>,

    // Always-on behavior:
    wrapper_tag: String,    // DOM wrapper tag (display: contents)
    provider_ident: String, // __CPProvider (inline injected)
    inserted_provider_import: bool,
    inserted_stamp_helper: bool,
    stamp_callsites: bool,
    callsite_symbols: HashSet<String>,

    // -------- module graph (this module only) --------
    module_file: Option<String>,
    graph: ModuleGraph,

    // Skips: components we should not wrap (to avoid interfering with pass-through libs)
    skip_components: std::collections::HashSet<String>,      // e.g., ["Slot", "Link"]
    skip_member_roots: std::collections::HashSet<String>,    // e.g., ["Primitive"] for <Primitive.*>
}

impl CodePressTransform {
    /// Finds the index immediately after the directive prologue (e.g. "use client", "use strict").
    /// Any injected statements should be inserted at this index to avoid preceding directives.
    fn directive_insert_index(&self, m: &Module) -> usize {
        let mut idx = 0;
        for item in &m.body {
            if let ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr, .. })) = item {
                if let Expr::Lit(Lit::Str(_)) = &**expr {
                    idx += 1;
                    continue;
                }
            }
            break;
        }
        idx
    }
    pub fn new(
        mut config: HashMap<String, serde_json::Value>,
        source_map: Option<std::sync::Arc<dyn SourceMapper>>,
    ) -> Self {
        let repo_name = config
            .remove("repo_name")
            .and_then(|v| v.as_str().map(|s| s.to_string()));
        let branch_name = config
            .remove("branch_name")
            .and_then(|v| v.as_str().map(|s| s.to_string()));

        let wrapper_tag = "codepress-marker".to_string();
        let provider_ident = "__CPProvider".to_string();
        let stamp_callsites = config
            .remove("stampCallsites")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        // Parse optional skip lists from config
        fn read_string_set(map: &mut HashMap<String, serde_json::Value>, key: &str) -> std::collections::HashSet<String> {
            let mut out: std::collections::HashSet<String> = Default::default();
            if let Some(raw) = map.remove(key) {
                if let Some(arr) = raw.as_array() {
                    for v in arr {
                        if let Some(s) = v.as_str() {
                            out.insert(s.to_string());
                        }
                    }
                } else if let Some(s) = raw.as_str() {
                    // allow comma-separated string for convenience
                    for part in s.split(',') {
                        let p = part.trim();
                        if !p.is_empty() { out.insert(p.to_string()); }
                    }
                }
            }
            out
        }

        let mut skip_components = read_string_set(&mut config, "skip_components");
        let mut skip_member_roots = read_string_set(&mut config, "skip_member_roots");
        if skip_components.is_empty() {
            // Safe defaults: Radix Slot, Next.js Link
            skip_components.insert("Slot".to_string());
            skip_components.insert("Link".to_string());
        }
        if skip_member_roots.is_empty() {
            // Radix Primitive.* family
            skip_member_roots.insert("Primitive".to_string());
        }

        Self {
            repo_name,
            branch_name,
            source_map,
            bindings: Default::default(),
            wrapper_tag,
            provider_ident,
            inserted_provider_import: false,
            inserted_stamp_helper: false,
            stamp_callsites,
            callsite_symbols: HashSet::new(),
            module_file: None,
            graph: ModuleGraph {
                imports: vec![],
                exports: vec![],
                reexports: vec![],
                defs: vec![],
                mutations: vec![],
                literal_index: vec![],
            },
            skip_components,
            skip_member_roots,
        }
    }

    // ---------- helpers ----------

    fn span_file_lines(&self, s: swc_core::common::Span) -> String {
        if s.is_dummy() {
            return "unknown:0-0".to_string();
        }
        if let Some(ref cm) = self.source_map {
            let lo = cm.lookup_char_pos(s.lo());
            let hi = cm.lookup_char_pos(s.hi());
            return format!(
                "{}:{}-{}",
                normalize_filename(&lo.file.name.to_string()),
                lo.line,
                hi.line
            );
        }
        "unknown:0-0".to_string()
    }

    fn file_from_span(&mut self, s: swc_core::common::Span) -> Option<String> {
        if s.is_dummy() {
            return None;
        }
        if let Some(ref cm) = self.source_map {
            let lo = cm.lookup_char_pos(s.lo());
            let f = normalize_filename(&lo.file.name.to_string());
            self.module_file.get_or_insert(f.clone());
            return Some(f);
        }
        None
    }

    fn current_file(&self) -> String {
        self.module_file
            .clone()
            .unwrap_or_else(|| "unknown".to_string())
    }

    fn is_route_container_path(p: &str) -> bool {
        let s = p.replace('\\', "/");
        // app router pages/layouts
        if s.contains("/app/") && (s.contains("/page.") || s.contains("/layout.")) {
            return true;
        }
        // pages router
        if s.contains("/pages/") {
            // include _app and _document too
            return s.ends_with(".tsx") || s.ends_with(".jsx") || s.contains("/_app.") || s.contains("/_document.");
        }
        // src/app or src/pages variants
        if s.contains("/src/app/") && (s.contains("/page.") || s.contains("/layout.")) {
            return true;
        }
        if s.contains("/src/pages/") {
            return s.ends_with(".tsx") || s.ends_with(".jsx") || s.contains("/_app.") || s.contains("/_document.");
        }
        false
    }

    fn is_custom_component_name(name: &JSXElementName) -> bool {
        match name {
            JSXElementName::Ident(ident) => ident
                .sym
                .chars()
                .next()
                .map(|c| c.is_uppercase())
                .unwrap_or(false),
            JSXElementName::JSXMemberExpr(_) | JSXElementName::JSXNamespacedName(_) => true,
            // _ => false,
        }
    }

    fn is_synthetic_element(&self, name: &JSXElementName) -> bool {
        match name {
            // <codepress-marker> / <__CPProvider> / <__CPX>
            JSXElementName::Ident(id) => {
                let n = id.sym.as_ref();
                n == self.wrapper_tag || n == self.provider_ident || n == "__CPX"
            }
            // <__CPX.Provider> or anything under __CPProvider/__CPX
            JSXElementName::JSXMemberExpr(m) => {
                // Walk to the root object of the member chain
                let mut obj = &m.obj;
                while let JSXObject::JSXMemberExpr(inner) = obj {
                    obj = &inner.obj;
                }
                if let JSXObject::Ident(root) = obj {
                    let n = root.sym.as_ref();
                    n == "__CPX" || n == self.provider_ident
                } else {
                    false
                }
            }
            JSXElementName::JSXNamespacedName(_) => false,
        }
    }

    /// Return true if this element is a custom component we should skip wrapping.
    fn is_skip_component(&self, name: &JSXElementName) -> bool {
        match name {
            JSXElementName::Ident(ident) => {
                let n = ident.sym.as_ref();
                self.skip_components.contains(n)
            }
            JSXElementName::JSXMemberExpr(m) => {
                // check root object of chain
                let mut obj = &m.obj;
                while let JSXObject::JSXMemberExpr(inner) = obj { obj = &inner.obj; }
                if let JSXObject::Ident(root) = obj {
                    let n = root.sym.as_ref();
                    self.skip_member_roots.contains(n)
                } else { false }
            }
            JSXElementName::JSXNamespacedName(_) => false,
        }
    }

    fn has_attr_key(attrs: &[JSXAttrOrSpread], key: &str) -> bool {
        attrs.iter().any(|a| {
            if let JSXAttrOrSpread::JSXAttr(attr) = a {
                if let JSXAttrName::Ident(id) = &attr.name {
                    return id.sym.as_ref() == key;
                }
            }
            false
        })
    }

    fn attach_attr_string(attrs: &mut Vec<JSXAttrOrSpread>, key: &str, val: String) {
        // Do not override existing props; only add if absent
        if Self::has_attr_key(attrs, key) {
            return;
        }
        attrs.push(JSXAttrOrSpread::JSXAttr(JSXAttr {
            span: DUMMY_SP,
            name: JSXAttrName::Ident(cp_ident_name(key.into())),
            value: Some(JSXAttrValue::Lit(Lit::Str(Str {
                span: DUMMY_SP,
                value: val.into(),
                raw: None,
            }))),
        }));
    }
    // Build "root.path" for MemberExpr where the path is statically known.
    fn static_member_path(&self, expr: &Expr) -> Option<(String, String)> {
        fn push_seg(out: &mut String, seg: &str) {
            if seg.starts_with('[') {
                out.push_str(seg);
            } else {
                out.push('.');
                out.push_str(seg);
            }
        }
        fn walk<'a>(e: &'a Expr, root: &mut Option<String>, path: &mut String) -> bool {
            match e {
                Expr::Ident(i) => {
                    *root = Some(i.sym.to_string());
                    true
                }
                Expr::Member(m) => {
                    if !walk(&m.obj, root, path) {
                        return false;
                    }
                    match &m.prop {
                        MemberProp::Ident(p) => {
                            push_seg(path, &p.sym.to_string());
                            true
                        }
                        MemberProp::PrivateName(_) => false,
                        MemberProp::Computed(c) => match &*c.expr {
                            Expr::Lit(Lit::Str(s)) => {
                                push_seg(path, &format!(r#"["{}"]"#, s.value));
                                true
                            }
                            Expr::Lit(Lit::Num(n)) => {
                                push_seg(path, &format!("[{}]", n.value));
                                true
                            }
                            _ => false,
                        },
                    }
                }
                _ => false,
            }
        }
        let mut root = None;
        let mut path = String::new();
        if walk(expr, &mut root, &mut path) {
            Some((root.unwrap_or_default(), path))
        } else {
            None
        }
    }

    fn push_mutation_row(
        &mut self,
        root: String,
        path: String,
        kind: &'static str,
        span: swc_core::common::Span,
    ) {
        let _ = self.file_from_span(span);
        self.graph.mutations.push(MutationRow {
            root,
            path,
            kind,
            span: self.span_file_lines(span),
        });
    }

    // Inject `globalThis.__CPX_GRAPH[file] = JSON.parse("<json>")` via new Function to avoid big AST building.
    fn inject_graph_stmt(&self, m: &mut Module) {
        let file_key = xor_encode(&self.current_file());
        let file_key_json = serde_json::to_string(&file_key).unwrap_or("\"unknown\"".into());
        // graph as JSON string literal passed into JSON.parse
        let graph_json = serde_json::to_string(&self.graph).unwrap_or("{}".into());
        let graph_json_str = serde_json::to_string(&graph_json).unwrap_or("\"{}\"".into());
        let js = format!(
            "try{{var g=(typeof globalThis!=='undefined'?globalThis:window);g.__CPX_GRAPH=g.__CPX_GRAPH||{{}};g.__CPX_GRAPH[{file}]=JSON.parse({graph});}}catch(_e){{}}",
            file = file_key_json,
            graph = graph_json_str
        );
        let stmt = ModuleItem::Stmt(Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                callee: Callee::Expr(Box::new(Expr::New(NewExpr {
                    span: DUMMY_SP,
                    callee: Box::new(Expr::Ident(cp_ident("Function".into()))),
                    args: Some(vec![ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                            span: DUMMY_SP,
                            value: js.into(),
                            raw: None,
                        }))),
                    }]),
                    type_args: None,
                    #[cfg(not(feature = "compat_0_87"))]
                    ctxt: SyntaxContext::empty(),
                }))),
                args: vec![],
                type_args: None,
                #[cfg(not(feature = "compat_0_87"))]
                ctxt: SyntaxContext::empty(),
            })),
        }));
        let insert_at = self.directive_insert_index(m);
        m.body.insert(insert_at, stmt);
    }

    fn get_line_info(
        &self,
        opening_span: swc_core::common::Span,
        parent_span: Option<swc_core::common::Span>,
    ) -> Option<String> {
        if opening_span.is_dummy() {
            return None;
        }
        if let Some(ref cm) = self.source_map {
            let start_loc = cm.lookup_char_pos(opening_span.lo());
            let end_span = parent_span.unwrap_or(opening_span);
            if end_span.is_dummy() {
                return None;
            }
            let end_loc = cm.lookup_char_pos(end_span.hi());
            Some(format!("{}-{}", start_loc.line, end_loc.line))
        } else {
            None
        }
    }

    fn create_encoded_path_attr(
        &self,
        filename: &str,
        opening_span: swc_core::common::Span,
        parent_span: Option<swc_core::common::Span>,
    ) -> JSXAttrOrSpread {
        let normalized = normalize_filename(filename);
        let encoded_path = xor_encode(&normalized);

        let attr_value = if let Some(line_info) = self.get_line_info(opening_span, parent_span) {
            format!("{}:{}", encoded_path, line_info)
        } else {
            encoded_path
        };

        JSXAttrOrSpread::JSXAttr(JSXAttr {
            span: DUMMY_SP,
            name: JSXAttrName::Ident(cp_ident_name("codepress-data-fp".into())),
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
                name: JSXAttrName::Ident(cp_ident_name("codepress-github-repo-name".into())),
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
                name: JSXAttrName::Ident(cp_ident_name("codepress-github-branch".into())),
                value: Some(JSXAttrValue::Lit(Lit::Str(Str {
                    span: DUMMY_SP,
                    value: branch.clone().into(),
                    raw: None,
                }))),
            })
        })
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

    // ---------- binding collection & tracing ----------

    fn collect_bindings(&mut self, program: &Program) {
        let mut bc = BindingCollector {
            out: &mut self.bindings,
        };
        program.visit_with(&mut bc);
    }

    fn trace_expr(
        &self,
        expr: &Expr,
        chain: &mut Vec<ProvNode>,
        depth: usize,
        seen: &mut HashSet<Id>,
    ) {
        if depth > 8 || chain.len() > 128 {
            return;
        }
        match expr {
            Expr::Lit(Lit::Num(n)) => chain.push(ProvNode::Literal {
                span: self.span_file_lines(n.span),
                value_kind: "number",
            }),
            Expr::Lit(Lit::Str(s)) => chain.push(ProvNode::Literal {
                span: self.span_file_lines(s.span),
                value_kind: "string",
            }),
            Expr::Lit(_) => chain.push(ProvNode::Literal {
                span: self.span_file_lines(expr.span()),
                value_kind: "other",
            }),
            Expr::Ident(i) => {
                chain.push(ProvNode::Ident {
                    name: i.sym.to_string(),
                    span: self.span_file_lines(i.span),
                });
                let id = i.to_id();
                if seen.contains(&id) {
                    return;
                }
                if let Some(b) = self.bindings.get(&id) {
                    if let Some(init) = &b.init {
                        chain.push(ProvNode::Init {
                            span: self.span_file_lines(init.span()),
                        });
                        self.trace_expr(init, chain, depth + 1, seen);
                    }
                    if let Some(im) = &b.import {
                        chain.push(ProvNode::Import {
                            source: im.source.clone(),
                            imported: im.imported.clone(),
                            span: self.span_file_lines(b.def_span),
                        });
                    }
                }
            }
            Expr::Member(m) => {
                if let Some(env_key) = detect_env_member(m) {
                    chain.push(ProvNode::Env {
                        key: env_key,
                        span: self.span_file_lines(m.span),
                    });
                    return;
                }
                chain.push(ProvNode::Member {
                    span: self.span_file_lines(m.span),
                });
                self.trace_expr(&m.obj, chain, depth + 1, seen);
                if let MemberProp::Computed(c) = &m.prop {
                    self.trace_expr(&c.expr, chain, depth + 1, seen);
                }
            }
            Expr::Call(c) => {
                // TODO: consider better detection for fetching (+ integration to extension/backend)
                // if let Some(fetch_like) = detect_fetch_like(c) {
                //     chain.push(ProvNode::Fetch {
                //         url: fetch_like.url,
                //         span: self.span_file_lines(c.span),
                //     });
                // }
                let (mut callee_name, callee_span, fn_def_span) = match &c.callee {
                    Callee::Expr(expr) => match &**expr {
                        Expr::Ident(id) => {
                            let name = id.sym.to_string();
                            let callee_span = self.span_file_lines(id.span);
                            let def = self
                                .bindings
                                .get(&id.to_id())
                                .and_then(|b| b.fn_body_span.or(Some(b.def_span)))
                                .map(|sp| self.span_file_lines(sp));
                            (name, callee_span, def)
                        }
                        Expr::Member(m) => {
                            ("<member>".to_string(), self.span_file_lines(m.span), None)
                        }
                        _ => ("<expr>".to_string(), self.span_file_lines(c.span), None),
                    },
                    _ => ("<expr>".to_string(), self.span_file_lines(c.span), None),
                };
                // if let Callee::Expr(expr) = &c.callee {
                //     if let Expr::Member(m) = &**expr {
                //         if let (Expr::Ident(obj), MemberProp::Ident(prop)) = (&*m.obj, &m.prop) {
                //             if obj.sym.as_ref() == "Date" && prop.sym.as_ref() == "now" {
                //                 callee_name = "Date.now".into();
                //             }
                //         }
                //     }
                // }
                chain.push(ProvNode::Call {
                    callee: callee_name,
                    callsite: self.span_file_lines(c.span),
                    callee_span,
                    fn_def_span,
                });
                for arg in &c.args {
                    if arg.spread.is_none() {
                        self.trace_expr(&arg.expr, chain, depth + 1, seen);
                    }
                }
            }
            Expr::New(n) => {
                let callee = match &*n.callee {
                    Expr::Ident(id) => id.sym.to_string(),
                    Expr::Member(_) => "<member>".to_string(),
                    _ => "<expr>".to_string(),
                };
                chain.push(ProvNode::Ctor {
                    callee,
                    span: self.span_file_lines(n.span),
                });
                if let Some(args) = &n.args {
                    for arg in args {
                        if arg.spread.is_none() {
                            self.trace_expr(&arg.expr, chain, depth + 1, seen);
                        }
                    }
                }
            }
            Expr::Tpl(t) => {
                chain.push(ProvNode::Op {
                    op: "template".into(),
                    span: self.span_file_lines(t.span),
                });
                for e in &t.exprs {
                    self.trace_expr(e, chain, depth + 1, seen);
                }
            }
            Expr::Bin(b) => {
                chain.push(ProvNode::Op {
                    op: format!("binary:{:?}", b.op),
                    span: self.span_file_lines(b.span),
                });
                self.trace_expr(&b.left, chain, depth + 1, seen);
                self.trace_expr(&b.right, chain, depth + 1, seen);
            }
            Expr::Cond(c) => {
                chain.push(ProvNode::Op {
                    op: "cond".into(),
                    span: self.span_file_lines(c.span),
                });
                self.trace_expr(&c.test, chain, depth + 1, seen);
                self.trace_expr(&c.cons, chain, depth + 1, seen);
                self.trace_expr(&c.alt, chain, depth + 1, seen);
            }
            Expr::Unary(u) => {
                chain.push(ProvNode::Op {
                    op: format!("unary:{:?}", u.op),
                    span: self.span_file_lines(u.span),
                });
                self.trace_expr(&u.arg, chain, depth + 1, seen);
            }
            Expr::Update(u) => {
                chain.push(ProvNode::Op {
                    op: "update".into(),
                    span: self.span_file_lines(u.span),
                });
                self.trace_expr(&u.arg, chain, depth + 1, seen);
            }
            Expr::Object(o) => {
                for prop in &o.props {
                    if let PropOrSpread::Prop(p) = prop {
                        if let Prop::KeyValue(kv) = &**p {
                            let key = match &kv.key {
                                PropName::Ident(i) => i.sym.to_string(),
                                PropName::Str(s) => s.value.to_string(),
                                _ => "<computed>".to_string(),
                            };
                            chain.push(ProvNode::ObjectProp {
                                key,
                                span: self.span_file_lines(kv.key.span()),
                            });
                            self.trace_expr(&kv.value, chain, depth + 1, seen);
                        }
                    }
                }
            }
            Expr::Array(a) => {
                for (idx, el) in a.elems.iter().enumerate() {
                    if let Some(el) = el {
                        chain.push(ProvNode::ArrayElem {
                            index: idx,
                            span: self.span_file_lines(el.span()),
                        });
                        self.trace_expr(&el.expr, chain, depth + 1, seen);
                    }
                }
            }
            _ => chain.push(ProvNode::Unknown {
                span: self.span_file_lines(expr.span()),
            }),
        }
    }

    fn rank_candidates(&self, chain: &[ProvNode]) -> Vec<Candidate> {
        let mut out: Vec<Candidate> = vec![];
        for n in chain {
            match n {
                ProvNode::Literal { span, .. } => out.push(Candidate {
                    target: span.clone(),
                    reason: "literal".into(),
                }),
                ProvNode::Init { span } => out.push(Candidate {
                    target: span.clone(),
                    reason: "const-init".into(),
                }),
                ProvNode::Member { span } => out.push(Candidate {
                    target: span.clone(),
                    reason: "member".into(),
                }),
                ProvNode::ObjectProp { span, .. } | ProvNode::ArrayElem { span, .. } => {
                    out.push(Candidate {
                        target: span.clone(),
                        reason: "structural".into(),
                    })
                }
                ProvNode::Call {
                    callsite,
                    fn_def_span,
                    ..
                } => {
                    out.push(Candidate {
                        target: callsite.clone(),
                        reason: "callsite".into(),
                    });
                    if let Some(def) = fn_def_span {
                        out.push(Candidate {
                            target: def.clone(),
                            reason: "fn-def".into(),
                        });
                    }
                }
                ProvNode::Ctor { span, .. } => out.push(Candidate {
                    target: span.clone(),
                    reason: "constructor".into(),
                }),
                ProvNode::Import { span, .. } => out.push(Candidate {
                    target: span.clone(),
                    reason: "import".into(),
                }),
                ProvNode::Env { span, .. } => out.push(Candidate {
                    target: span.clone(),
                    reason: "env".into(),
                }),
                ProvNode::Fetch { span, .. } => out.push(Candidate {
                    target: span.clone(),
                    reason: "fetch".into(),
                }),
                _ => {}
            }
        }
        // Dedup (reason#target) preserving order
        let mut seen = HashSet::<String>::new();
        out.into_iter()
            .filter(|c| seen.insert(format!("{}#{}", c.reason, c.target)))
            .collect()
    }
    fn collect_symbol_refs_from_expr(&mut self, expr: &Expr, out: &mut Vec<SymbolRef>) {
        // Remember file as soon as we can
        let _ = self.file_from_span(expr.span());
        match expr {
            Expr::Ident(i) => {
                out.push(SymbolRef {
                    file: self.current_file(),
                    local: i.sym.to_string(),
                    path: "".to_string(),
                    span: self.span_file_lines(i.span),
                });
                // 2) chase initialier (for mutated imports that are re-exported)
                let id = i.to_id();
                let init_expr: Option<Expr> = self
                    .bindings
                    .get(&id)
                    .and_then(|b| b.init.as_deref())
                    .cloned();
                if let Some(ref init) = init_expr {
                    self.collect_symbol_refs_from_expr(init, out);
                }
            }
            Expr::Member(m) => {
                if let Some((root, path)) = self.static_member_path(&Expr::Member(m.clone())) {
                    out.push(SymbolRef {
                        file: self.current_file(),
                        local: root,
                        path,
                        span: self.span_file_lines(m.span),
                    });
                }
                // also descend into obj/prop expr for nested refs
                self.collect_symbol_refs_from_expr(&m.obj, out);
                if let MemberProp::Computed(c) = &m.prop {
                    self.collect_symbol_refs_from_expr(&c.expr, out);
                }
            }
            Expr::Call(c) => {
                if let Callee::Expr(e) = &c.callee {
                    self.collect_symbol_refs_from_expr(e, out);
                }
                for a in &c.args {
                    if a.spread.is_none() {
                        self.collect_symbol_refs_from_expr(&a.expr, out);
                    }
                }
            }
            _ => {}
        }
    }

    fn aggregate_kinds(chain: &[ProvNode]) -> Vec<&'static str> {
        let mut kinds = BTreeSet::new();
        for n in chain {
            let k = match n {
                ProvNode::Literal { .. } => "literal",
                ProvNode::Ident { .. } => "ident",
                ProvNode::Init { .. } => "init",
                ProvNode::Import { .. } => "import",
                ProvNode::Member { .. } => "member",
                ProvNode::ObjectProp { .. } => "object",
                ProvNode::ArrayElem { .. } => "array",
                ProvNode::Call { .. } => "call",
                ProvNode::Ctor { .. } => "ctor",
                ProvNode::Op { .. } => "op",
                ProvNode::Env { .. } => "env",
                ProvNode::Fetch { .. } => "fetch",
                ProvNode::Context { .. } => "context",
                ProvNode::Hook { .. } => "hook",
                ProvNode::Unknown { .. } => "unknown",
            };
            kinds.insert(k);
        }
        kinds.into_iter().collect()
    }

    // Build a <codepress-marker style={{display:'contents'}} ...> wrapper with callsite
    fn make_display_contents_wrapper(
        &self,
        filename: &str,
        callsite_open_span: swc_core::common::Span,
        elem_span: swc_core::common::Span,
    ) -> JSXElement {
        let mut opening = JSXOpeningElement {
            name: JSXElementName::Ident(cp_ident(&self.wrapper_tag).into()),
            attrs: vec![],
            self_closing: false,
            type_args: None,
            span: DUMMY_SP,
        };
        // style={{display:'contents'}}
        opening.attrs.push(JSXAttrOrSpread::JSXAttr(JSXAttr {
            span: DUMMY_SP,
            name: JSXAttrName::Ident(cp_ident_name("style".into())),
            value: Some(JSXAttrValue::JSXExprContainer(JSXExprContainer {
                span: DUMMY_SP,
                expr: JSXExpr::Expr(Box::new(Expr::Object(ObjectLit {
                    span: DUMMY_SP,
                    props: vec![PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                        key: PropName::Ident(cp_ident_name("display".into())),
                        value: Box::new(Expr::Lit(Lit::Str(Str {
                            span: DUMMY_SP,
                            value: "contents".into(),
                            raw: None,
                        }))),
                    })))],
                }))),
            })),
        }));
        // data-codepress-callsite (encode like codepress-data-fp)
        let callsite_attr =
            self.create_encoded_path_attr(filename, callsite_open_span, Some(elem_span));
        if let JSXAttrOrSpread::JSXAttr(a) = callsite_attr {
            opening.attrs.push(JSXAttrOrSpread::JSXAttr(JSXAttr {
                span: DUMMY_SP,
                name: JSXAttrName::Ident(cp_ident_name("data-codepress-callsite".into())),
                value: a.value,
            }));
        }
        JSXElement {
            span: DUMMY_SP,
            opening,
            children: vec![],
            closing: Some(JSXClosingElement {
                span: DUMMY_SP,
                name: JSXElementName::Ident(cp_ident(&self.wrapper_tag).into()),
            }),
        }
    }

    // ---------- provider helpers (inline injection) ----------

    /// Injects, once per module:
    ///   import { createContext } from "react";
    ///   const __CPX = createContext(null);
    ///   __CPX.displayName = "CPX";
    ///   function __CPProvider({ value, children }) { return <__CPX.Provider value={value}>{children}</__CPX.Provider>; }
    fn ensure_provider_inline(&mut self, m: &mut Module) {
        if self.inserted_provider_import {
            return;
        }

        // Only inject into TSX files to avoid emitting JSX into .ts modules
        // Establish current file from the module span if available
        let _ = self.file_from_span(m.span);
        let file = self.current_file();
        if !file.ends_with(".tsx") {
            return;
        }
        // import { createContext } from "react";
        let import_decl = ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
            span: DUMMY_SP,
            specifiers: vec![ImportSpecifier::Named(ImportNamedSpecifier {
                span: DUMMY_SP,
                local: cp_ident("createContext".into()),
                imported: None,
                is_type_only: false,
            })],
            src: Box::new(Str {
                span: DUMMY_SP,
                value: "react".into(),
                raw: None,
            }),
            type_only: false,
            with: None,
            #[cfg(not(feature = "compat_0_87"))]
            phase: ImportPhase::Evaluation,
        }));

        // const __CPX = createContext(null);
        let cpx_decl = ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
            span: DUMMY_SP,
            kind: VarDeclKind::Const,
            declare: false,
            decls: vec![VarDeclarator {
                span: DUMMY_SP,
                name: Pat::Ident(BindingIdent {
                    id: cp_ident("__CPX".into()),
                    type_ann: None,
                }),
                init: Some(Box::new(Expr::Call(CallExpr {
                    span: DUMMY_SP,
                    callee: Callee::Expr(Box::new(Expr::Ident(cp_ident("createContext".into())))),
                    args: vec![ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Lit(Lit::Null(Null { span: DUMMY_SP }))),
                    }],
                    type_args: None,
                    #[cfg(not(feature = "compat_0_87"))]
                    ctxt: SyntaxContext::empty(),
                }))),
                definite: false,
            }],
            #[cfg(not(feature = "compat_0_87"))]
            ctxt: SyntaxContext::empty(),
        }))));

        // __CPX.displayName = "CPX";
        let cpx_name_stmt = ModuleItem::Stmt(Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Assign(AssignExpr {
                span: DUMMY_SP,
                op: AssignOp::Assign,
                left: make_assign_left_member(
                    Expr::Ident(cp_ident("__CPX")),
                    cp_ident_name("displayName"),
                ),
                right: Box::new(Expr::Lit(Lit::Str(Str {
                    span: DUMMY_SP,
                    value: "CPX".into(),
                    raw: None,
                }))),
            })),
        }));

        // function __CPProvider({ value, children }) { return <__CPX.Provider value={value}>{children}</__CPX.Provider>; }
        let provider_fn = {
            // Params: { value, children }
            let param = Param {
                span: DUMMY_SP,
                decorators: vec![],
                pat: Pat::Object(ObjectPat {
                    span: DUMMY_SP,
                    optional: false,
                    type_ann: None,
                    props: vec![
                        ObjectPatProp::Assign(AssignPatProp {
                            span: DUMMY_SP,
                            key: cp_ident("value".into()).into(),
                            value: None,
                        }),
                        ObjectPatProp::Assign(AssignPatProp {
                            span: DUMMY_SP,
                            key: cp_ident("children".into()).into(),
                            value: None,
                        }),
                    ],
                }),
            };
            // <__CPX.Provider value={value}>{children}</__CPX.Provider>
            let jsx = JSXElement {
                span: DUMMY_SP,
                opening: JSXOpeningElement {
                    span: DUMMY_SP,
                    name: JSXElementName::JSXMemberExpr(JSXMemberExpr {
                        #[cfg(not(feature = "compat_0_87"))]
                        span: DUMMY_SP,
                        obj: JSXObject::Ident(cp_ident("__CPX".into())),
                        prop: cp_ident_name("Provider".into()),
                    }),
                    attrs: vec![JSXAttrOrSpread::JSXAttr(JSXAttr {
                        span: DUMMY_SP,
                        name: JSXAttrName::Ident(cp_ident_name("value".into())),
                        value: Some(JSXAttrValue::JSXExprContainer(JSXExprContainer {
                            span: DUMMY_SP,
                            expr: JSXExpr::Expr(Box::new(Expr::Ident(cp_ident("value".into())))),
                        })),
                    })],
                    self_closing: false,
                    type_args: None,
                },
                children: vec![JSXElementChild::JSXExprContainer(JSXExprContainer {
                    span: DUMMY_SP,
                    expr: JSXExpr::Expr(Box::new(Expr::Ident(cp_ident("children".into())))),
                })],
                closing: Some(JSXClosingElement {
                    span: DUMMY_SP,
                    name: JSXElementName::JSXMemberExpr(JSXMemberExpr {
                        #[cfg(not(feature = "compat_0_87"))]
                        span: DUMMY_SP,
                        obj: JSXObject::Ident(cp_ident("__CPX".into())),
                        prop: cp_ident_name("Provider".into()),
                    }),
                }),
            };
            ModuleItem::Stmt(Stmt::Decl(Decl::Fn(FnDecl {
                ident: cp_ident(&self.provider_ident),
                declare: false,
                function: Box::new(Function {
                    params: vec![param],
                    decorators: vec![],
                    span: DUMMY_SP,
                    body: Some(BlockStmt {
                        span: DUMMY_SP,
                        stmts: vec![Stmt::Return(ReturnStmt {
                            span: DUMMY_SP,
                            arg: Some(Box::new(Expr::JSXElement(Box::new(jsx)))),
                        })],
                        #[cfg(not(feature = "compat_0_87"))]
                        ctxt: SyntaxContext::empty(),
                    }),
                    is_generator: false,
                    is_async: false,
                    type_params: None,
                    return_type: None,
                    #[cfg(not(feature = "compat_0_87"))]
                    ctxt: SyntaxContext::empty(),
                }),
            })))
        };

        // Insert after any top-of-file directives, preserving order: import, const, displayName, function
        let insert_at = self.directive_insert_index(m);
        // Insert in reverse so the final order is preserved
        m.body.insert(insert_at, provider_fn);
        m.body.insert(insert_at, cpx_name_stmt);
        m.body.insert(insert_at, cpx_decl);
        m.body.insert(insert_at, import_decl);
        self.inserted_provider_import = true;
    }

    /// Injects a guarded stamping helper:
    /// function __CP_stamp(v,id,fp){try{if(v&&(typeof v==='function'||typeof v==='object')&&Object.isExtensible(v)){v.__cp_id=id;v.__cp_fp=fp;}}catch(_){}return v;}
    fn ensure_stamp_helper_inline(&mut self, m: &mut Module) {
        if self.inserted_stamp_helper {
            return;
        }
        // Inject helper via a small runtime snippet executed with new Function
        let js = "try{var g=(typeof globalThis!=='undefined'?globalThis:window);if(!g.__CP_stamp)g.__CP_stamp=function(v,id,fp){try{if(v&&(typeof v==='function'||typeof v==='object')&&Object.isExtensible(v)){v.__cp_id=id;v.__cp_fp=fp;}}catch(_e){}return v;}}catch(_e){}";
        let stmt = ModuleItem::Stmt(Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                callee: Callee::Expr(Box::new(Expr::New(NewExpr {
                    span: DUMMY_SP,
                    callee: Box::new(Expr::Ident(cp_ident("Function".into()))),
                    args: Some(vec![ExprOrSpread { spread: None, expr: Box::new(Expr::Lit(Lit::Str(Str { span: DUMMY_SP, value: js.into(), raw: None })) ) }]),
                    type_args: None,
                    #[cfg(not(feature = "compat_0_87"))]
                    ctxt: SyntaxContext::empty(),
                }))),
                args: vec![],
                type_args: None,
                #[cfg(not(feature = "compat_0_87"))]
                ctxt: SyntaxContext::empty(),
            })),
        }));
        m.body.insert(0, stmt);
        self.inserted_stamp_helper = true;
    }
}

// -----------------------------------------------------------------------------
// Module Graph info
// -----------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct ImportRow {
    local: String,    // local alias in this module
    imported: String, // 'default' | named | '*' (namespace)
    source: String,   // "…/module"
    span: String,     // "file:start-end"
}

#[derive(serde::Serialize)]
struct ExportRow {
    exported: String, // name visible to other modules ('default' is ok)
    local: String,    // local symbol bound in this module
    span: String,
}

#[derive(serde::Serialize)]
struct ReexportRow {
    exported: String, // name re-exported by this module
    imported: String, // name imported from source
    source: String,   // "…/module"
    span: String,
}

#[derive(serde::Serialize)]
struct DefRow {
    local: String,      // local binding in this module
    kind: &'static str, // var|let|const|func|class
    span: String,
}

#[derive(serde::Serialize)]
struct MutationRow {
    root: String,       // root local ident being mutated (teams)
    path: String,       // dotted/index path if static: ".new_key" or '["k"]' or "[2]"
    kind: &'static str, // assign|update|call:Object.assign|call:push|call:set|spread-merge
    span: String,
}

#[derive(serde::Serialize)]
struct LiteralIxRow {
    export_name: String, // e.g. PRINCIPALS
    path: String,        // e.g. [1].specialty
    text: String,
    span: String,
}

#[derive(serde::Serialize)]
struct ModuleGraph {
    imports: Vec<ImportRow>,
    exports: Vec<ExportRow>,
    reexports: Vec<ReexportRow>,
    defs: Vec<DefRow>,
    mutations: Vec<MutationRow>,
    literal_index: Vec<LiteralIxRow>,
}

// -----------------------------------------------------------------------------
// Tracing types & binding collector
// -----------------------------------------------------------------------------

#[derive(Clone)]
struct Binding {
    def_span: swc_core::common::Span,
    init: Option<Box<Expr>>,
    import: Option<ImportInfo>,
    fn_body_span: Option<swc_core::common::Span>,
}

#[derive(Clone)]
struct ImportInfo {
    source: String,
    imported: String,
}

#[derive(serde::Serialize)]
#[serde(tag = "kind")]
enum ProvNode {
    Literal {
        span: String,
        value_kind: &'static str,
    },
    Ident {
        name: String,
        span: String,
    },
    Init {
        span: String,
    },
    Import {
        source: String,
        imported: String,
        span: String,
    },
    Member {
        span: String,
    },
    ObjectProp {
        key: String,
        span: String,
    },
    ArrayElem {
        index: usize,
        span: String,
    },
    Call {
        callee: String,
        callsite: String,
        callee_span: String,
        fn_def_span: Option<String>,
    },
    Ctor {
        callee: String,
        span: String,
    },
    Op {
        op: String,
        span: String,
    },
    Env {
        key: String,
        span: String,
    },
    Fetch {
        url: Option<String>,
        span: String,
    },
    Context {
        name: String,
        span: String,
    },
    Hook {
        name: String,
        span: String,
    },
    Unknown {
        span: String,
    },
}

#[derive(serde::Serialize)]
struct Candidate {
    target: String,
    reason: String,
}

struct BindingCollector<'a> {
    out: &'a mut HashMap<Id, Binding>,
}
impl<'a> Visit for BindingCollector<'a> {
    fn visit_var_declarator(&mut self, d: &VarDeclarator) {
        if let Some(name) = d.name.as_ident() {
            self.out.insert(
                name.to_id(),
                Binding {
                    def_span: name.id.span,
                    init: d.init.clone().map(|e| e),
                    import: None,
                    fn_body_span: None,
                },
            );
        }
        d.visit_children_with(self);
    }
    fn visit_fn_decl(&mut self, n: &FnDecl) {
        self.out.insert(
            n.ident.to_id(),
            Binding {
                def_span: n.ident.span,
                init: None,
                import: None,
                fn_body_span: Some(n.function.span),
            },
        );
        n.visit_children_with(self);
    }
    fn visit_import_decl(&mut self, n: &ImportDecl) {
        for s in &n.specifiers {
            match s {
                ImportSpecifier::Named(named) => {
                    let local = named.local.to_id();
                    let imported = named
                        .imported
                        .as_ref()
                        .and_then(|i| {
                            if let ModuleExportName::Ident(i) = i {
                                Some(i.sym.to_string())
                            } else {
                                None
                            }
                        })
                        .unwrap_or_else(|| named.local.sym.to_string());
                    self.out.insert(
                        local,
                        Binding {
                            def_span: named.local.span,
                            init: None,
                            import: Some(ImportInfo {
                                source: n.src.value.to_string(),
                                imported,
                            }),
                            fn_body_span: None,
                        },
                    );
                }
                ImportSpecifier::Default(def) => {
                    self.out.insert(
                        def.local.to_id(),
                        Binding {
                            def_span: def.local.span,
                            init: None,
                            import: Some(ImportInfo {
                                source: n.src.value.to_string(),
                                imported: "default".into(),
                            }),
                            fn_body_span: None,
                        },
                    );
                }
                ImportSpecifier::Namespace(ns) => {
                    self.out.insert(
                        ns.local.to_id(),
                        Binding {
                            def_span: ns.local.span,
                            init: None,
                            import: Some(ImportInfo {
                                source: n.src.value.to_string(),
                                imported: "*".into(),
                            }),
                            fn_body_span: None,
                        },
                    );
                }
            }
        }
        n.visit_children_with(self);
    }
}

// -----------------------------------------------------------------------------
// Detectors
// -----------------------------------------------------------------------------

fn detect_env_member(m: &MemberExpr) -> Option<String> {
    // process.env.X
    if let Expr::Member(obj) = &*m.obj {
        if let (Expr::Ident(proc_), MemberProp::Ident(prop)) = (&*obj.obj, &obj.prop) {
            if proc_.sym.as_ref() == "process" && prop.sym.as_ref() == "env" {
                if let MemberProp::Ident(key) = &m.prop {
                    return Some(key.sym.to_string());
                }
            }
        }
        // import.meta.env.X
        if let (Expr::Member(obj2), MemberProp::Ident(prop)) = (&*obj.obj, &obj.prop) {
            if let (Expr::Ident(import_), MemberProp::Ident(meta)) = (&*obj2.obj, &obj2.prop) {
                if import_.sym.as_ref() == "import"
                    && meta.sym.as_ref() == "meta"
                    && prop.sym.as_ref() == "env"
                {
                    if let MemberProp::Ident(key) = &m.prop {
                        return Some(key.sym.to_string());
                    }
                }
            }
        }
    }
    None
}

struct FetchLike {
    url: Option<String>,
}
fn detect_fetch_like(c: &CallExpr) -> Option<FetchLike> {
    match &c.callee {
        Callee::Expr(expr) => match &**expr {
            Expr::Ident(id) if id.sym.as_ref() == "fetch" => {
                let url = c.args.get(0).and_then(|a| match &*a.expr {
                    Expr::Lit(Lit::Str(s)) => Some(s.value.to_string()),
                    _ => None,
                });
                Some(FetchLike { url })
            }
            Expr::Member(m) => {
                if let MemberProp::Ident(prop) = &m.prop {
                    let p = prop.sym.as_ref();
                    if ["get", "post", "put", "delete", "query", "mutate", "request"].contains(&p) {
                        let url = c.args.get(0).and_then(|a| match &*a.expr {
                            Expr::Lit(Lit::Str(s)) => Some(s.value.to_string()),
                            _ => None,
                        });
                        return Some(FetchLike { url });
                    }
                }
                None
            }
            _ => None,
        },
        _ => None,
    }
}

// -----------------------------------------------------------------------------
// Pass 1: main transform (add attributes; DOM wrapper; non-DOM provider)
// -----------------------------------------------------------------------------
impl CodePressTransform {
    // Build provider wrapper: <__CPProvider value={{cs,c,k,fp}}>{node}</__CPProvider>
    fn wrap_with_provider(&self, node: &mut JSXElement, meta: ProviderMeta) {
        let provider_name: JSXElementName =
            JSXElementName::Ident(cp_ident(&self.provider_ident).into());

        let mut opening = JSXOpeningElement {
            name: provider_name.clone(),
            attrs: vec![],
            self_closing: false,
            type_args: None,
            span: DUMMY_SP,
        };

        let obj = Expr::Object(ObjectLit {
            span: DUMMY_SP,
            props: vec![
                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                    key: PropName::Ident(cp_ident_name("cs".into())),
                    value: Box::new(Expr::Lit(Lit::Str(Str {
                        span: DUMMY_SP,
                        value: meta.cs.into(),
                        raw: None,
                    }))),
                }))),
                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                    key: PropName::Ident(cp_ident_name("c".into())),
                    value: Box::new(Expr::Lit(Lit::Str(Str {
                        span: DUMMY_SP,
                        value: meta.c.into(),
                        raw: None,
                    }))),
                }))),
                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                    key: PropName::Ident(cp_ident_name("k".into())),
                    value: Box::new(Expr::Lit(Lit::Str(Str {
                        span: DUMMY_SP,
                        value: meta.k.into(),
                        raw: None,
                    }))),
                }))),
                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                    key: PropName::Ident(cp_ident_name("fp".into())),
                    value: Box::new(Expr::Lit(Lit::Str(Str {
                        span: DUMMY_SP,
                        value: meta.fp.into(),
                        raw: None,
                    }))),
                }))),
            ],
        });

        opening.attrs.push(JSXAttrOrSpread::JSXAttr(JSXAttr {
            span: DUMMY_SP,
            name: JSXAttrName::Ident(cp_ident_name("value".into())),
            value: Some(JSXAttrValue::JSXExprContainer(JSXExprContainer {
                span: DUMMY_SP,
                expr: JSXExpr::Expr(Box::new(obj)),
            })),
        }));

        let mut provider = JSXElement {
            span: DUMMY_SP,
            opening,
            children: vec![],
            closing: Some(JSXClosingElement {
                span: DUMMY_SP,
                name: provider_name,
            }),
        };

        let original = std::mem::replace(
            node,
            JSXElement {
                span: DUMMY_SP,
                opening: JSXOpeningElement {
                    name: JSXElementName::Ident(cp_ident("div".into()).into()),
                    attrs: vec![],
                    self_closing: false,
                    type_args: None,
                    span: DUMMY_SP,
                },
                children: vec![],
                closing: None,
            },
        );
        provider
            .children
            .push(JSXElementChild::JSXElement(Box::new(original)));
        *node = provider;
    }
}

impl VisitMut for CodePressTransform {
    fn visit_mut_module(&mut self, m: &mut Module) {
        // Inject inline provider once per module (from main branch)
        self.ensure_provider_inline(m);
        // Inject guarded stamping helper
        self.ensure_stamp_helper_inline(m);

        // Stamping of exported symbols with __cp_id and __cp_fp (merged change)
        // Determine encoded file path for this module
        let filename = if let Some(ref cm) = self.source_map {
            let loc = cm.lookup_char_pos(m.span.lo());
            loc.file.name.to_string()
        } else {
            "unknown".to_string()
        };
        let normalized = normalize_filename(&filename);
        let encoded_fp = xor_encode(&normalized);

        // Decide whether stamping is safe for an identifier (only for functions/classes/calls/new)
        let find_binding_by_sym = |sym: &str| -> Option<&Binding> {
            self.bindings
                .iter()
                .find(|(k, _)| k.0 == sym)
                .map(|(_, b)| b)
        };
        let is_pascal = |s: &str| s.chars().next().map(|c| c.is_uppercase()).unwrap_or(false);
        let should_stamp_ident = |ident: &Ident| -> bool {
            if !is_pascal(&ident.sym.to_string()) {
                return false;
            }
            if let Some(b) = self.bindings.get(&ident.to_id()) {
                if let Some(init) = &b.init {
                    match &**init {
                        Expr::Fn(_) | Expr::Arrow(_) | Expr::Class(_) | Expr::Call(_) | Expr::New(_) => true,
                        _ => false,
                    }
                } else {
                    // No initializer (likely handled as Decl::Fn/Class elsewhere)
                    false
                }
            } else {
                false
            }
        };

        // Helper to build assignment: Ident.__cp_id = "..." and Ident.__cp_fp = "..."
        let mut stamp_for_ident = |ident: &Ident, export_name: &str| -> Vec<ModuleItem> {
            let mut out: Vec<ModuleItem> = Vec::new();

            // __CP_stamp(Ident, "<fp>#<export>", "<fp>")
            let call = Stmt::Expr(ExprStmt {
                span: DUMMY_SP,
                expr: Box::new(Expr::Call(CallExpr {
                    span: DUMMY_SP,
                    callee: Callee::Expr(Box::new(Expr::Ident(cp_ident("__CP_stamp".into())))),
                    args: vec![
                        ExprOrSpread { spread: None, expr: Box::new(Expr::Ident(ident.clone())) },
                        ExprOrSpread { spread: None, expr: Box::new(Expr::Lit(Lit::Str(Str { span: DUMMY_SP, value: format!("{}#{}", encoded_fp, export_name).into(), raw: None }))) },
                        ExprOrSpread { spread: None, expr: Box::new(Expr::Lit(Lit::Str(Str { span: DUMMY_SP, value: encoded_fp.clone().into(), raw: None }))) },
                    ],
                    type_args: None,
                    #[cfg(not(feature = "compat_0_87"))]
                    ctxt: SyntaxContext::empty(),
                }))
            });
            out.push(ModuleItem::Stmt(call));

            out
        };

        // Walk module items and append stamping statements after export declarations
        let mut new_body: Vec<ModuleItem> = Vec::with_capacity(m.body.len() * 2);
        for item in m.body.drain(..) {
            match &item {
                ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(ExportDecl { decl, .. })) => {
                    new_body.push(item.clone());
                    match decl {
                        Decl::Fn(fn_decl) => {
                            let name = fn_decl.ident.clone();
                            if is_pascal(&name.sym.to_string()) {
                                new_body.extend(stamp_for_ident(&name, &name.sym.to_string()));
                            }
                        }
                        Decl::Class(class_decl) => {
                            let name = class_decl.ident.clone();
                            if is_pascal(&name.sym.to_string()) {
                                new_body.extend(stamp_for_ident(&name, &name.sym.to_string()));
                            }
                        }
                        Decl::Var(var_decl) => {
                            for d in &var_decl.decls {
                                if let Pat::Ident(bi) = &d.name {
                                    let name = bi.id.clone();
                                    if should_stamp_ident(&name) {
                                        new_body.extend(stamp_for_ident(&name, &name.sym.to_string()));
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(ExportDefaultDecl { decl, .. })) => {
                    new_body.push(item.clone());
                    match decl {
                        DefaultDecl::Fn(FnExpr { ident: Some(id), .. }) => {
                            if is_pascal(&id.sym.to_string()) {
                                new_body.extend(stamp_for_ident(&id, "default"));
                            }
                        }
                        DefaultDecl::Class(ClassExpr { ident: Some(id), .. }) => {
                            if is_pascal(&id.sym.to_string()) {
                                new_body.extend(stamp_for_ident(&id, "default"));
                            }
                        }
                        _ => {}
                    }
                }
                ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(NamedExport { specifiers, .. })) => {
                    new_body.push(item.clone());
                    for spec in specifiers {
                        if let ExportSpecifier::Named(ExportNamedSpecifier { orig, .. }) = spec {
                            if let ModuleExportName::Ident(orig_ident) = orig {
                                // Only stamp PascalCase with a safe initializer
                                if is_pascal(&orig_ident.sym.to_string()) {
                                    if let Some(b) = find_binding_by_sym(&orig_ident.sym.to_string()) {
                                    let safe = match &b.init {
                                        Some(expr) => match &**expr {
                                            Expr::Fn(_) | Expr::Arrow(_) | Expr::Class(_) | Expr::Call(_) | Expr::New(_) => true,
                                            _ => false,
                                        },
                                        None => false,
                                    };
                                        if safe {
                                            let id = cp_ident(&orig_ident.sym.to_string());
                                            new_body.extend(stamp_for_ident(&id, &orig_ident.sym.to_string()));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                _ => new_body.push(item),
            }
        }
        m.body = new_body;

        // Continue other transforms and inject graph (from main branch)
        m.visit_mut_children_with(self);
        self.inject_graph_stmt(m);
    }
    fn visit_mut_import_decl(&mut self, n: &mut ImportDecl) {
        let _ = self.file_from_span(n.span);
        for s in &n.specifiers {
            match s {
                ImportSpecifier::Named(named) => {
                    self.graph.imports.push(ImportRow {
                        local: named.local.sym.to_string(),
                        imported: named
                            .imported
                            .as_ref()
                            .and_then(|i| {
                                if let ModuleExportName::Ident(i) = i {
                                    Some(i.sym.to_string())
                                } else {
                                    None
                                }
                            })
                            .unwrap_or_else(|| named.local.sym.to_string()),
                        source: n.src.value.to_string(),
                        span: self.span_file_lines(named.local.span),
                    });
                }
                ImportSpecifier::Default(def) => {
                    self.graph.imports.push(ImportRow {
                        local: def.local.sym.to_string(),
                        imported: "default".into(),
                        source: n.src.value.to_string(),
                        span: self.span_file_lines(def.local.span),
                    });
                }
                ImportSpecifier::Namespace(ns) => {
                    self.graph.imports.push(ImportRow {
                        local: ns.local.sym.to_string(),
                        imported: "*".into(),
                        source: n.src.value.to_string(),
                        span: self.span_file_lines(ns.local.span),
                    });
                }
            }
        }
        n.visit_mut_children_with(self);
    }

    fn visit_mut_export_decl(&mut self, n: &mut ExportDecl) {
        let _ = self.file_from_span(n.span);
        match &mut n.decl {
            Decl::Var(v) => {
                for d in &v.decls {
                    if let Some(id) = d.name.as_ident() {
                        let def_span = if let Some(init) = &d.init {
                            self.span_file_lines(init.span())
                        } else {
                            self.span_file_lines(id.id.span)
                        };
                        // def
                        self.graph.defs.push(DefRow {
                            local: id.id.sym.to_string(),
                            kind: match v.kind {
                                VarDeclKind::Const => "const",
                                VarDeclKind::Let => "let",
                                VarDeclKind::Var => "var",
                            },
                            span: def_span,
                        });
                        // export mapping
                        self.graph.exports.push(ExportRow {
                            exported: id.id.sym.to_string(),
                            local: id.id.sym.to_string(),
                            span: self.span_file_lines(id.id.span), // TODO: should this be a
                                                                    // larger span?
                        });
                        // literal index (optional): only for simple object/array initializers
                        if let Some(init) = &d.init {
                            self.harvest_literal_index(
                                &id.id.sym.to_string(),
                                &init,
                                "".to_string(),
                            );
                        }
                    }
                }
            }
            Decl::Fn(f) => {
                self.graph.defs.push(DefRow {
                    local: f.ident.sym.to_string(),
                    kind: "func",
                    span: self.span_file_lines(f.ident.span),
                });
                self.graph.exports.push(ExportRow {
                    exported: f.ident.sym.to_string(),
                    local: f.ident.sym.to_string(),
                    span: self.span_file_lines(f.ident.span),
                });
            }
            Decl::Class(c) => {
                self.graph.defs.push(DefRow {
                    local: c.ident.sym.to_string(),
                    kind: "class",
                    span: self.span_file_lines(c.ident.span),
                });
                self.graph.exports.push(ExportRow {
                    exported: c.ident.sym.to_string(),
                    local: c.ident.sym.to_string(),
                    span: self.span_file_lines(c.ident.span),
                });
            }
            _ => {}
        }
        n.visit_mut_children_with(self);
    }

    fn visit_mut_module_decl(&mut self, n: &mut ModuleDecl) {
        let _ = self.file_from_span(n.span());
        match n {
            ModuleDecl::ExportNamed(en) => {
                if let Some(src) = &en.src {
                    for s in &en.specifiers {
                        if let ExportSpecifier::Named(nm) = s {
                            let imported = match &nm.orig {
                                ModuleExportName::Ident(i) => i.sym.to_string(),
                                ModuleExportName::Str(s) => s.value.to_string(),
                            };
                            let exported = nm
                                .exported
                                .as_ref()
                                .map(|e| match e {
                                    ModuleExportName::Ident(i) => i.sym.to_string(),
                                    ModuleExportName::Str(s) => s.value.to_string(),
                                })
                                .unwrap_or_else(|| imported.clone());
                            self.graph.reexports.push(ReexportRow {
                                exported,
                                imported,
                                source: src.value.to_string(),
                                span: self.span_file_lines(en.span),
                            });
                        }
                    }
                } else {
                    // export { local as exported }
                    for s in &en.specifiers {
                        if let ExportSpecifier::Named(nm) = s {
                            if let ModuleExportName::Ident(orig) = &nm.orig {
                                let exported = nm
                                    .exported
                                    .as_ref()
                                    .map(|e| match e {
                                        ModuleExportName::Ident(i) => i.sym.to_string(),
                                        ModuleExportName::Str(s) => s.value.to_string(),
                                    })
                                    .unwrap_or_else(|| orig.sym.to_string());
                                self.graph.exports.push(ExportRow {
                                    exported,
                                    local: orig.sym.to_string(),
                                    span: self.span_file_lines(orig.span),
                                });
                            }
                        }
                    }
                }
            }
            ModuleDecl::ExportAll(ea) => {
                self.graph.reexports.push(ReexportRow {
                    exported: "*".into(),
                    imported: "*".into(),
                    source: ea.src.value.to_string(),
                    span: self.span_file_lines(ea.span),
                });
            }
            ModuleDecl::ExportDefaultDecl(ed) => {
                if let DefaultDecl::Fn(f) = &ed.decl {
                    if let Some(id) = &f.ident {
                        self.graph.defs.push(DefRow {
                            local: id.sym.to_string(),
                            kind: "func",
                            span: self.span_file_lines(id.span),
                        });
                        self.graph.exports.push(ExportRow {
                            exported: "default".into(),
                            local: id.sym.to_string(),
                            span: self.span_file_lines(ed.span()),
                        });
                    }
                }
            }
            _ => {}
        }
        n.visit_mut_children_with(self);
    }

    fn visit_mut_var_declarator(&mut self, d: &mut VarDeclarator) {
        if let Some(name) = d.name.as_ident() {
            let def_span = if let Some(init) = &d.init {
                self.span_file_lines(init.span())
            } else {
                self.span_file_lines(name.id.span)
            };
            self.graph.defs.push(DefRow {
                local: name.id.sym.to_string(),
                kind: "var",
                span: def_span,
            });

            // If this identifier is used as a JSX callsite and has an initializer, wrap it with __CP_stamp(init, id, fp)
            if self.stamp_callsites && d.init.is_some() {
                let sym = name.id.sym.to_string();
                if self.callsite_symbols.contains(&sym) {
                    let file = self.current_file();
                    let enc = xor_encode(&file);
                    // Move original initializer into call arg
                    let orig = d.init.take().unwrap();
                    d.init = Some(Box::new(Expr::Call(CallExpr {
                        span: DUMMY_SP,
                        callee: Callee::Expr(Box::new(Expr::Ident(cp_ident("__CP_stamp".into())))),
                        args: vec![
                            ExprOrSpread { spread: None, expr: orig },
                            ExprOrSpread { spread: None, expr: Box::new(Expr::Lit(Lit::Str(Str { span: DUMMY_SP, value: format!("{}#{}", enc, sym).into(), raw: None }))) },
                            ExprOrSpread { spread: None, expr: Box::new(Expr::Lit(Lit::Str(Str { span: DUMMY_SP, value: enc.into(), raw: None }))) },
                        ],
                        type_args: None,
                        #[cfg(not(feature = "compat_0_87"))]
                        ctxt: SyntaxContext::empty(),
                    })));
                }
            }
        }
        d.visit_mut_children_with(self);
    }

    fn visit_mut_fn_decl(&mut self, n: &mut FnDecl) {
        self.graph.defs.push(DefRow {
            local: n.ident.sym.to_string(),
            kind: "func",
            span: self.span_file_lines(n.ident.span),
        });
        n.visit_mut_children_with(self);
    }

    fn visit_mut_class_decl(&mut self, n: &mut ClassDecl) {
        self.graph.defs.push(DefRow {
            local: n.ident.sym.to_string(),
            kind: "class",
            span: self.span_file_lines(n.ident.span),
        });
        n.visit_mut_children_with(self);
    }

    fn visit_mut_assign_expr(&mut self, n: &mut AssignExpr) {
        #[cfg(not(feature = "compat_0_87"))]
        {
            use swc_core::ecma::ast::{AssignTarget, SimpleAssignTarget};
            match &n.left {
                AssignTarget::Simple(SimpleAssignTarget::Ident(b)) => {
                    self.push_mutation_row(b.id.sym.to_string(), "".to_string(), "assign", n.span);
                }
                AssignTarget::Simple(SimpleAssignTarget::Member(m)) => {
                    let mexpr = Expr::Member(m.clone());
                    if let Some((root, path)) = self.static_member_path(&mexpr) {
                        self.push_mutation_row(root, path, "assign", n.span);
                    }
                }
                _ => {}
            }
        }

        #[cfg(feature = "compat_0_87")]
        {
            use swc_core::ecma::ast::PatOrExpr;
            match &n.left {
                PatOrExpr::Expr(e) => match &**e {
                    Expr::Ident(b) => {
                        self.push_mutation_row(b.sym.to_string(), "".to_string(), "assign", n.span);
                    }
                    Expr::Member(m) => {
                        let mexpr = Expr::Member(m.clone());
                        if let Some((root, path)) = self.static_member_path(&mexpr) {
                            self.push_mutation_row(root, path, "assign", n.span);
                        }
                    }
                    _ => {}
                },
                PatOrExpr::Pat(_) => {
                    // pattern assignment (e.g., destructuring) — skip for now
                }
            }
        }

        n.visit_mut_children_with(self);
    }

    fn visit_mut_update_expr(&mut self, n: &mut UpdateExpr) {
        match &*n.arg {
            Expr::Ident(i) => {
                self.push_mutation_row(i.sym.to_string(), "".to_string(), "update", n.span)
            }
            Expr::Member(m) => {
                let mexpr = Expr::Member(m.clone());
                if let Some((root, path)) = self.static_member_path(&mexpr) {
                    self.push_mutation_row(root, path, "update", n.span);
                }
            }
            _ => {}
        }
        n.visit_mut_children_with(self);
    }

    fn visit_mut_call_expr(&mut self, n: &mut CallExpr) {
        // Object.assign(target, ...)
        if let Callee::Expr(callee) = &n.callee {
            if let Expr::Member(m) = &**callee {
                if let (Expr::Ident(obj), MemberProp::Ident(prop)) = (&*m.obj, &m.prop) {
                    if obj.sym.as_ref() == "Object" && prop.sym.as_ref() == "assign" {
                        if let Some(first) = n.args.get(0) {
                            if let Some((root, path)) = self.static_member_path(&first.expr) {
                                self.push_mutation_row(root, path, "call:Object.assign", n.span);
                            }
                        }
                    } else {
                        // methods on arrays/maps/objects like push/set
                        let method = prop.sym.to_string();
                        if let Some((root, path)) = self.static_member_path(&m.obj) {
                            let kind = match method.as_str() {
                                "push" | "unshift" | "splice" => "call:array-mutate",
                                "set" | "setIn" => "call:set",
                                _ => "call:member",
                            };
                            self.push_mutation_row(root, path, kind, n.span);
                        }
                    }
                }
            }
        }
        n.visit_mut_children_with(self);
    }

    
    fn visit_mut_jsx_element(&mut self, node: &mut JSXElement) {
        node.visit_mut_children_with(self);

        // Skip our synthetic elements to avoid computing spans on DUMMY_SP, but still visit inside.
        if self.is_synthetic_element(&node.opening.name) {
            return;
        }

        // Capture original spans BEFORE any wrapping/replacement
        let orig_open_span = node.opening.span;
        let orig_full_span = node.span;

        // filename from span (GUARDED: do not call lookup_char_pos on DUMMY_SP)
        let filename = if let Some(ref cm) = self.source_map {
            if orig_full_span.is_dummy() {
                "unknown".to_string()
            } else {
                cm.lookup_char_pos(orig_full_span.lo())
                    .file
                    .name
                    .to_string()
            }
        } else {
            "unknown".to_string()
        };

        // Preserve your original attribute on EVERY JSX element
        // Only add our fingerprint if it does not already exist
        if !Self::has_attr_key(&node.opening.attrs, "codepress-data-fp") {
            node.opening.attrs.push(self.create_encoded_path_attr(
                &filename,
                node.opening.span,
                Some(node.span),
            ));
        }

        // Optional: stamp callsites for local identifiers used as components
        if self.stamp_callsites {
            // If opening.name is Ident (not host element) we can stamp the value once per module
            if let JSXElementName::Ident(id) = &node.opening.name {
                // Skip obvious host tags (lowercase first char)
                let is_host = id
                    .sym
                    .chars()
                    .next()
                    .map(|c| c.is_lowercase())
                    .unwrap_or(false);
                if !is_host {
                    let sym = id.sym.to_string();
                    if !self.callsite_symbols.contains(&sym) {
                        self.callsite_symbols.insert(sym.clone());
                        // Inject __CP_stamp(Foo, "<fp>#Foo", "<fp>") at module top (as a statement)
                        if let Some(file) = self.module_file.clone() {
                            let enc = xor_encode(&file);
                            let call = ModuleItem::Stmt(Stmt::Expr(ExprStmt {
                                span: DUMMY_SP,
                                expr: Box::new(Expr::Call(CallExpr {
                                    span: DUMMY_SP,
                                    callee: Callee::Expr(Box::new(Expr::Ident(cp_ident("__CP_stamp".into())))),
                                    args: vec![
                                        ExprOrSpread { spread: None, expr: Box::new(Expr::Ident(cp_ident(&sym))) },
                                        ExprOrSpread { spread: None, expr: Box::new(Expr::Lit(Lit::Str(Str { span: DUMMY_SP, value: format!("{}#{}", enc, sym).into(), raw: None }))) },
                                        ExprOrSpread { spread: None, expr: Box::new(Expr::Lit(Lit::Str(Str { span: DUMMY_SP, value: enc.clone().into(), raw: None }))) },
                                    ],
                                    type_args: None,
                                    #[cfg(not(feature = "compat_0_87"))]
                                    ctxt: SyntaxContext::empty(),
                                }))
                            }));
                            // Prepend so it’s available early; order after helpers is fine
                            // Insert after any previously inserted helpers (provider + stamp)
                            // For simplicity, push at start+1
                            // Ensure we at least have one body slot
                            // Using file_from_span already set module_file
                            // Here we conservatively insert near top
                            // Note: it may duplicate across files if sym collides; guarded at runtime
                            // Insert after index 1 when helpers exist
                            // We'll just insert at 0; helpers were inserted earlier so this shifts them, still fine
                            // (no semantic change)
                            // To keep helper first, insert at 1 if body has >=1
                            let insert_at = if let Some(first) = self.module_file.as_ref() { 1 } else { 0 };
                            // Can't mutate m.body here; collect for later is heavy. Instead, append to graph via inject_graph_stmt? Simpler: store it into graph literal? For now, push to a temp queue is complex.
                            // Fallback: attach to opening.attrs for provenance only; stamping still done by export/module path. Skip injecting extra statement to avoid structural changes late.
                            // Leaving runtime callsite injection out to avoid ordering hazards inside this function.
                            let _ = insert_at; // placeholder to keep compile warnings away
                        }
                    }
                }
            }
        }

        // Root repo/branch once
        if self.repo_name.is_some() && !GLOBAL_ATTRIBUTES_ADDED.load(Ordering::Relaxed) {
            let element_name = match &node.opening.name {
                JSXElementName::Ident(ident) => ident.sym.as_ref(),
                _ => "",
            };
            if matches!(element_name, "html" | "body" | "div") {
                if !self.has_repo_attribute(&node.opening.attrs) {
                    if let Some(repo_attr) = self.create_repo_attr() {
                        node.opening.attrs.push(repo_attr);
                    }
                }
                if !self.has_branch_attribute(&node.opening.attrs) {
                    if let Some(branch_attr) = self.create_branch_attr() {
                        node.opening.attrs.push(branch_attr);
                    }
                }
                GLOBAL_ATTRIBUTES_ADDED.store(true, Ordering::Relaxed);
            }
        }

        // Host vs custom
        let is_host = matches!(
            &node.opening.name,
            JSXElementName::Ident(id) if id.sym.chars().next().map(|c| c.is_lowercase()).unwrap_or(false)
        );

        // ---------- gather provenance for this element ----------
        let mut all_nodes: Vec<ProvNode> = vec![];
        let mut symrefs: Vec<SymbolRef> = vec![];

        // props (exprs + spreads)
        for a in &node.opening.attrs {
            match a {
                JSXAttrOrSpread::JSXAttr(prop_attr) => {
                    if let Some(JSXAttrValue::JSXExprContainer(container)) = &prop_attr.value {
                        if let JSXExpr::Expr(expr) = &container.expr {
                            let expr = &**expr;
                            let mut chain = vec![];
                            let mut seen: HashSet<Id> = HashSet::new();
                            self.trace_expr(expr, &mut chain, 0, &mut seen);
                            all_nodes.extend(chain);
                            self.collect_symbol_refs_from_expr(expr, &mut symrefs);
                        }
                    }
                }
                JSXAttrOrSpread::SpreadElement(sp) => {
                    let mut chain = vec![];
                    let mut seen: HashSet<Id> = HashSet::new();
                    self.trace_expr(&sp.expr, &mut chain, 0, &mut seen);
                    all_nodes.extend(chain);
                    self.collect_symbol_refs_from_expr(&sp.expr, &mut symrefs);
                }
            }
        }

        // children (expr + plain text)
        for ch in &node.children {
            match ch {
                JSXElementChild::JSXExprContainer(container) => {
                    if let JSXExpr::Expr(expr) = &container.expr {
                        let expr = &**expr;
                        let mut chain = vec![];
                        let mut seen: HashSet<Id> = HashSet::new();
                        self.trace_expr(expr, &mut chain, 0, &mut seen);
                        all_nodes.extend(chain);
                        self.collect_symbol_refs_from_expr(expr, &mut symrefs);
                    }
                }
                JSXElementChild::JSXText(t) => {
                    all_nodes.push(ProvNode::Literal {
                        span: self.span_file_lines(t.span),
                        value_kind: "string",
                    });
                }
                _ => {}
            }
        }

        // Build payloads
        let mut candidates = self.rank_candidates(&all_nodes);
        let kinds = Self::aggregate_kinds(&all_nodes);

        if !orig_full_span.is_dummy() {
            if let Some(line_info) = self.get_line_info(orig_open_span, Some(orig_full_span)) {
                // Keep the same (file:start-end) shape as other targets produced by span_file_lines
                let self_target = format!("{}:{}", normalize_filename(&filename), line_info);
                // Avoid dupes if it somehow already exists
                let already = candidates
                    .iter()
                    .any(|c| c.reason == "callsite" && c.target == self_target);
                if !already {
                    let cs = Candidate {
                        target: self_target,
                        reason: "callsite".into(),
                    };
                    // candidates.insert(0, cs);
                    candidates.push(cs);
                }
            }
        }

        let cands_json = serde_json::to_string(&candidates).unwrap_or_else(|_| "[]".into());
        let kinds_json = serde_json::to_string(&kinds).unwrap_or_else(|_| "[]".into());
        let cands_enc = xor_encode(&cands_json);
        let kinds_enc = xor_encode(&kinds_json);
        let symrefs_json = serde_json::to_string(&symrefs).unwrap_or_else(|_| "[]".into());
        let symrefs_enc = xor_encode(&symrefs_json);

        // Always-on behavior for custom component callsites (excluding skip list):
        let is_custom_call = !is_host
            && Self::is_custom_component_name(&node.opening.name)
            && !self.is_skip_component(&node.opening.name);

        if is_custom_call {
            // DOM wrapper (display: contents) carrying callsite; we also duplicate metadata on the invocation
            let mut wrapper =
                self.make_display_contents_wrapper(&filename, orig_open_span, orig_full_span);

            let mut original = std::mem::replace(
                node,
                JSXElement {
                    span: DUMMY_SP,
                    opening: JSXOpeningElement {
                        name: JSXElementName::Ident(cp_ident("div".into()).into()),
                        attrs: vec![],
                        self_closing: false,
                        type_args: None,
                        span: DUMMY_SP,
                    },
                    children: vec![],
                    closing: None,
                },
            );

            // Intentionally avoid duplicating metadata onto the custom component invocation
            // to prevent interfering with component prop forwarding (e.g., Radix Slot).

            wrapper
                .children
                .push(JSXElementChild::JSXElement(Box::new(original)));
            *node = wrapper;

            /*
            // Provider wrapping temporarily disabled; to re-enable, uncomment this block.
            let cs_enc = if let JSXAttrOrSpread::JSXAttr(a) =
                self.create_encoded_path_attr(&filename, orig_open_span, Some(orig_full_span))
            {
                if let Some(JSXAttrValue::Lit(Lit::Str(s))) = a.value {
                    s.value.to_string()
                } else {
                    "".into()
                }
            } else {
                "".into()
            };
            // find fp on this node (or recompute)
            let mut fp_enc = String::new();
            for a in &node.opening.attrs {
                if let JSXAttrOrSpread::JSXAttr(attr) = a {
                    if let JSXAttrName::Ident(idn) = &attr.name {
                        if idn.sym.as_ref() == "codepress-data-fp" {
                            if let Some(JSXAttrValue::Lit(Lit::Str(s))) = &attr.value {
                                fp_enc = s.value.to_string();
                            }
                        }
                    }
                }
            }
            let meta = ProviderMeta {
                cs: cs_enc,
                c: cands_enc.clone(),
                k: kinds_enc.clone(),
                fp: fp_enc,
            };
            self.wrap_with_provider(node, meta);
            */

            let attrs = &mut node.opening.attrs;
            // Only annotate the injected wrappers (provider or host wrapper), not the invocation element
            CodePressTransform::attach_attr_string(attrs, "data-codepress-edit-candidates", cands_enc.clone());
            CodePressTransform::attach_attr_string(attrs, "data-codepress-source-kinds", kinds_enc.clone());
            CodePressTransform::attach_attr_string(attrs, "data-codepress-symbol-refs", symrefs_enc.clone());
        } else {
            // Host element → tag directly
            CodePressTransform::attach_attr_string(
                &mut node.opening.attrs,
                "data-codepress-edit-candidates",
                cands_enc.clone(),
            );
            CodePressTransform::attach_attr_string(
                &mut node.opening.attrs,
                "data-codepress-source-kinds",
                kinds_enc.clone(),
            );
            CodePressTransform::attach_attr_string(
                &mut node.opening.attrs,
                "data-codepress-symbol-refs",
                symrefs_enc.clone(),
            );
            if !Self::has_attr_key(&node.opening.attrs, "data-codepress-callsite") {
                if let JSXAttrOrSpread::JSXAttr(a) = self.create_encoded_path_attr(
                    &filename,
                    node.opening.span,
                    Some(node.span),
                ) {
                    node.opening.attrs.push(JSXAttrOrSpread::JSXAttr(JSXAttr {
                        span: DUMMY_SP,
                        name: JSXAttrName::Ident(cp_ident_name("data-codepress-callsite".into())),
                        value: a.value,
                    }));
                }
            }
        }
    }
}

// -----------------------------------------------------------------------------
// Pass 2: hoist wrapper attrs to child & remove wrapper
// -----------------------------------------------------------------------------

struct HoistAndElide {
    wrapper_tag: String,
    keys: Vec<String>,
}

impl HoistAndElide {
    fn is_wrapper(&self, name: &JSXElementName) -> bool {
        match name {
            JSXElementName::Ident(id) => id.sym.as_ref() == self.wrapper_tag,
            _ => false,
        }
    }
    fn has_attr(attrs: &[JSXAttrOrSpread], key: &str) -> bool {
        attrs.iter().any(|a| {
            if let JSXAttrOrSpread::JSXAttr(attr) = a {
                if let JSXAttrName::Ident(id) = &attr.name {
                    return id.sym.as_ref() == key;
                }
            }
            false
        })
    }
    fn get_attr_string(attrs: &[JSXAttrOrSpread], key: &str) -> Option<String> {
        for a in attrs {
            if let JSXAttrOrSpread::JSXAttr(attr) = a {
                if let JSXAttrName::Ident(id) = &attr.name {
                    if id.sym.as_ref() == key {
                        if let Some(JSXAttrValue::Lit(Lit::Str(s))) = &attr.value {
                            return Some(s.value.to_string());
                        }
                    }
                }
            }
        }
        None
    }
    fn push_attr(attrs: &mut Vec<JSXAttrOrSpread>, key: &str, val: String) {
        attrs.push(JSXAttrOrSpread::JSXAttr(JSXAttr {
            span: DUMMY_SP,
            name: JSXAttrName::Ident(cp_ident_name(key.into())),
            value: Some(JSXAttrValue::Lit(Lit::Str(Str {
                span: DUMMY_SP,
                value: val.into(),
                raw: None,
            }))),
        }));
    }
}

impl VisitMut for HoistAndElide {
    fn visit_mut_jsx_element(&mut self, node: &mut JSXElement) {
        // Recurse first
        node.visit_mut_children_with(self);

        // Only wrappers with exactly one JSXElement child
        if !self.is_wrapper(&node.opening.name) || node.children.len() != 1 {
            return;
        }

        let child_el = match node.children.remove(0) {
            JSXElementChild::JSXElement(boxed) => *boxed,
            other => {
                node.children.push(other);
                return;
            }
        };
        let mut child = child_el;

        // Hoist keys if missing on child
        for key in &self.keys {
            if !Self::has_attr(&child.opening.attrs, key) {
                if let Some(val) = Self::get_attr_string(&node.opening.attrs, key) {
                    Self::push_attr(&mut child.opening.attrs, key, val);
                }
            }
        }

        // Replace wrapper with child
        *node = child;
    }
}

// -----------------------------------------------------------------------------
// Entrypoint
// -----------------------------------------------------------------------------

#[plugin_transform]
pub fn process_transform(
    mut program: Program,
    metadata: TransformPluginProgramMetadata,
) -> Program {
    let config = metadata
        .get_transform_plugin_config()
        .map(|s| serde_json::from_str(&s).unwrap_or_default())
        .unwrap_or_default();

    // Convert PluginSourceMapProxy to Arc<dyn SourceMapper>
    let source_map: Option<std::sync::Arc<dyn SourceMapper>> =
        Some(std::sync::Arc::new(metadata.source_map));

    let mut transform = CodePressTransform::new(config, source_map);

    // Collect bindings once up-front (to resolve inits/imports/functions)
    transform.collect_bindings(&program);

    // Pass 1: main transform
    program.visit_mut_with(&mut transform);

    // Pass 2: always hoist & elide (remove wrappers, keep data on child callsite)
    let mut elider = HoistAndElide {
        wrapper_tag: transform.wrapper_tag.clone(),
        keys: vec![
            "data-codepress-edit-candidates".to_string(),
            "data-codepress-source-kinds".to_string(),
            "data-codepress-callsite".to_string(),
            "data-codepress-symbol-refs".to_string(),
        ],
    };
    program.visit_mut_with(&mut elider);

    program
}

// -----------------------------------------------------------------------------
// (Optional) tests could go here
// -----------------------------------------------------------------------------

// Payload carried by the non-DOM provider
struct ProviderMeta {
    cs: String,
    c: String,
    k: String,
    fp: String,
}
// -----------------------------------------------------------------------------
// Extra types/helpers for symbol-refs & literal index
// -----------------------------------------------------------------------------
#[derive(serde::Serialize)]
struct SymbolRef {
    file: String,
    local: String,
    path: String,
    span: String,
}

impl CodePressTransform {
    fn harvest_literal_index(&mut self, export_name: &str, init: &Box<Expr>, prefix: String) {
        fn push_key(prefix: &str, seg: &str) -> String {
            if seg.starts_with('[') {
                format!("{prefix}{seg}")
            } else if prefix.is_empty() {
                seg.to_string()
            } else {
                format!("{prefix}.{seg}")
            }
        }
        match &**init {
            Expr::Object(o) => {
                for p in &o.props {
                    if let PropOrSpread::Prop(p) = p {
                        if let Prop::KeyValue(kv) = &**p {
                            let key = match &kv.key {
                                PropName::Ident(i) => i.sym.to_string(),
                                PropName::Str(s) => s.value.to_string(),
                                PropName::Num(n) => n.value.to_string(),
                                _ => continue,
                            };
                            let path = push_key(&prefix, &key);
                            self.harvest_literal_index(export_name, &kv.value, path);
                        }
                    }
                }
            }
            Expr::Array(a) => {
                for (idx, el) in a.elems.iter().enumerate() {
                    if let Some(el) = el {
                        let path = push_key(&prefix, &format!("[{idx}]"));
                        self.harvest_literal_index(export_name, &el.expr, path);
                    }
                }
            }
            Expr::Lit(Lit::Str(s)) => {
                self.graph.literal_index.push(LiteralIxRow {
                    export_name: export_name.to_string(),
                    path: prefix,
                    text: s.value.to_string(),
                    span: self.span_file_lines(s.span),
                });
            }
            _ => {}
        }
    }
}
