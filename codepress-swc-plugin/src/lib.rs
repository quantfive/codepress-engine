use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use swc_core::{
    common::{SourceMapper, Spanned, DUMMY_SP, SyntaxContext},
    ecma::{
        ast::{Id, IdentName, ImportPhase, *},
        visit::{Visit, VisitMut, VisitMutWith, VisitWith},
    },
    plugin::{plugin_transform, proxies::TransformPluginProgramMetadata},
};

// -----------------------------------------------------------------------------
// Globals
// -----------------------------------------------------------------------------

static GLOBAL_ATTRIBUTES_ADDED: AtomicBool = AtomicBool::new(false);

// -----------------------------------------------------------------------------
// Encoding & filename helpers
// -----------------------------------------------------------------------------

fn xor_encode(input: &str) -> String {
    // TODO: turn on encoding for production
    // const SECRET: &[u8] = b"codepress-file-obfuscation";
    // let xored: Vec<u8> = input
    //     .bytes()
    //     .enumerate()
    //     .map(|(i, b)| b ^ SECRET[i % SECRET.len()])
    //     .collect();
    // URL_SAFE_NO_PAD.encode(xored)
    input.to_string()
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
    for prefix in &["turbopack/[project]/", "/turbopack/[project]/", "[project]/"] {
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
    wrapper_tag: String,        // DOM wrapper tag (display: contents)
    provider_ident: String,     // __CPProvider (inline injected)
    inserted_provider_import: bool,
}

impl CodePressTransform {
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

        Self {
            repo_name,
            branch_name,
            source_map,
            bindings: Default::default(),
            wrapper_tag,
            provider_ident,
            inserted_provider_import: false,
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

    fn attach_attr_string(attrs: &mut Vec<JSXAttrOrSpread>, key: &str, val: String) {
        attrs.push(JSXAttrOrSpread::JSXAttr(JSXAttr {
            span: DUMMY_SP,
            name: JSXAttrName::Ident(IdentName::new(key.into(), DUMMY_SP)),
            value: Some(JSXAttrValue::Lit(Lit::Str(Str {
                span: DUMMY_SP,
                value: val.into(),
                raw: None,
            }))),
        }));
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
                name: JSXAttrName::Ident(IdentName::new(
                    "codepress-github-repo-name".into(),
                    DUMMY_SP,
                )),
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
                name: JSXAttrName::Ident(IdentName::new(
                    "codepress-github-branch".into(),
                    DUMMY_SP,
                )),
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
        let mut bc = BindingCollector { out: &mut self.bindings };
        program.visit_with(&mut bc);
    }

    fn trace_expr(&self, expr: &Expr, chain: &mut Vec<ProvNode>, depth: usize, seen: &mut HashSet<Id>) {
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
                            span: self.span_file_lines(b.def_span),
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
                    Callee::Expr(expr) => {
                           match &**expr {
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
                           }
                       }
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
                ProvNode::Literal { span, .. } => {
                    out.push(Candidate { target: span.clone(), reason: "literal".into() })
                }
                ProvNode::Init { span } => {
                    out.push(Candidate { target: span.clone(), reason: "const-init".into() })
                }
                ProvNode::Member { span } => {
                    out.push(Candidate { target: span.clone(), reason: "member".into() })
                }
                ProvNode::ObjectProp { span, .. } | ProvNode::ArrayElem { span, .. } => out.push(
                    Candidate { target: span.clone(), reason: "structural".into() },
                ),
                ProvNode::Call { callsite, fn_def_span, .. } => {
                    out.push(Candidate { target: callsite.clone(), reason: "callsite".into() });
                    if let Some(def) = fn_def_span {
                        out.push(Candidate { target: def.clone(), reason: "fn-def".into() });
                    }
                }
                ProvNode::Ctor { span, .. } => {
                    out.push(Candidate { target: span.clone(), reason: "constructor".into() })
                }
                ProvNode::Import { span, .. } => {
                    out.push(Candidate { target: span.clone(), reason: "import".into() })
                }
                ProvNode::Env { span, .. } => {
                    out.push(Candidate { target: span.clone(), reason: "env".into() })
                }
                ProvNode::Fetch { span, .. } => {
                    out.push(Candidate { target: span.clone(), reason: "fetch".into() })
                }
                _ => {}
            }
        }
        // Dedup (reason#target) preserving order
        let mut seen = HashSet::<String>::new();
        out.into_iter()
            .filter(|c| seen.insert(format!("{}#{}", c.reason, c.target)))
            .collect()
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
            name: JSXElementName::Ident(Ident::new(self.wrapper_tag.clone().into(), DUMMY_SP, SyntaxContext::empty()).into()),
            attrs: vec![],
            self_closing: false,
            type_args: None,
            span: DUMMY_SP,
        };
        // style={{display:'contents'}}
        opening.attrs.push(JSXAttrOrSpread::JSXAttr(JSXAttr {
            span: DUMMY_SP,
            name: JSXAttrName::Ident(IdentName::new("style".into(), DUMMY_SP)),
            value: Some(JSXAttrValue::JSXExprContainer(JSXExprContainer {
                span: DUMMY_SP,
                expr: JSXExpr::Expr(Box::new(Expr::Object(ObjectLit {
                    span: DUMMY_SP,
                    props: vec![PropOrSpread::Prop(Box::new(Prop::KeyValue(
                        KeyValueProp {
                            key: PropName::Ident(IdentName::new("display".into(), DUMMY_SP)),
                            value: Box::new(Expr::Lit(Lit::Str(Str {
                                span: DUMMY_SP,
                                value: "contents".into(),
                                raw: None,
                            }))),
                        },
                    )))],
                }))),
            })),
        }));
        // data-codepress-callsite (encode like codepress-data-fp)
        let callsite_attr =
            self.create_encoded_path_attr(filename, callsite_open_span, Some(elem_span));
        if let JSXAttrOrSpread::JSXAttr(a) = callsite_attr {
            opening.attrs.push(JSXAttrOrSpread::JSXAttr(JSXAttr {
                span: DUMMY_SP,
                name: JSXAttrName::Ident(IdentName::new("data-codepress-callsite".into(), DUMMY_SP)),
                value: a.value,
            }));
        }
        JSXElement {
            span: DUMMY_SP,
            opening,
            children: vec![],
            closing: Some(JSXClosingElement {
                span: DUMMY_SP,
                name: JSXElementName::Ident(Ident::new(self.wrapper_tag.clone().into(), DUMMY_SP, SyntaxContext::empty()).into()),
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
        // import { createContext } from "react";
        let import_decl = ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
            span: DUMMY_SP,
            specifiers: vec![ImportSpecifier::Named(ImportNamedSpecifier {
                span: DUMMY_SP,
                local: Ident::new("createContext".into(), DUMMY_SP, SyntaxContext::empty()),
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
                    id: Ident::new("__CPX".into(), DUMMY_SP, SyntaxContext::empty()),
                    type_ann: None,
                }),
                init: Some(Box::new(Expr::Call(CallExpr {
                    span: DUMMY_SP,
                    callee: Callee::Expr(Box::new(Expr::Ident(Ident::new(
                        "createContext".into(),
                        DUMMY_SP,
                        SyntaxContext::empty(),
                    )))),
                    args: vec![ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Lit(Lit::Null(Null { span: DUMMY_SP }))),
                    }],
                    type_args: None,
                    ctxt: SyntaxContext::empty(),
                }))),
                definite: false,
            }],
            ctxt: SyntaxContext::empty(),
        }))));

        // __CPX.displayName = "CPX";
        let cpx_name_stmt = ModuleItem::Stmt(Stmt::Expr(ExprStmt {
            span: DUMMY_SP,
            expr: Box::new(Expr::Assign(AssignExpr {
                span: DUMMY_SP,
                op: AssignOp::Assign,
                left: AssignTarget::Simple(SimpleAssignTarget::Member(MemberExpr {
                    span: DUMMY_SP,
                    obj: Box::new(Expr::Ident(Ident::new("__CPX".into(), DUMMY_SP, SyntaxContext::empty()))),
                    prop: MemberProp::Ident(IdentName::new("displayName".into(), DUMMY_SP)),
                })),
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
                            key: Ident::new("value".into(), DUMMY_SP, SyntaxContext::empty()).into(),
                            value: None,
                        }),
                        ObjectPatProp::Assign(AssignPatProp {
                            span: DUMMY_SP,
                            key: Ident::new("children".into(), DUMMY_SP, SyntaxContext::empty()).into(),
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
                        span: DUMMY_SP,
                        obj: JSXObject::Ident(Ident::new("__CPX".into(), DUMMY_SP, SyntaxContext::empty())),
                        prop: IdentName::new("Provider".into(), DUMMY_SP),
                    }),
                    attrs: vec![JSXAttrOrSpread::JSXAttr(JSXAttr {
                        span: DUMMY_SP,
                        name: JSXAttrName::Ident(IdentName::new("value".into(), DUMMY_SP)),
                        value: Some(JSXAttrValue::JSXExprContainer(JSXExprContainer {
                            span: DUMMY_SP,
                            expr: JSXExpr::Expr(Box::new(Expr::Ident(Ident::new(
                                "value".into(),
                                DUMMY_SP,
                                SyntaxContext::empty(),
                            )))),
                        })),
                    })],
                    self_closing: false,
                    type_args: None,
                },
                children: vec![JSXElementChild::JSXExprContainer(JSXExprContainer {
                    span: DUMMY_SP,
                    expr: JSXExpr::Expr(Box::new(Expr::Ident(Ident::new(
                        "children".into(),
                        DUMMY_SP,
                        SyntaxContext::empty(),
                    )))),
                })],
                closing: Some(JSXClosingElement {
                    span: DUMMY_SP,
                    name: JSXElementName::JSXMemberExpr(JSXMemberExpr {
                        span: DUMMY_SP,
                        obj: JSXObject::Ident(Ident::new("__CPX".into(), DUMMY_SP, SyntaxContext::empty())),
                        prop: IdentName::new("Provider".into(), DUMMY_SP),
                    }),
                }),
            };
            ModuleItem::Stmt(Stmt::Decl(Decl::Fn(FnDecl {
                ident: Ident::new(self.provider_ident.clone().into(), DUMMY_SP, SyntaxContext::empty()),
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
                        ctxt: SyntaxContext::empty(),
                    }),
                    is_generator: false,
                    is_async: false,
                    type_params: None,
                    return_type: None,
                    ctxt: SyntaxContext::empty(),
                }),
            })))
        };

        // Prepend in order
        m.body.insert(0, provider_fn);
        m.body.insert(0, cpx_name_stmt);
        m.body.insert(0, cpx_decl);
        m.body.insert(0, import_decl);
        self.inserted_provider_import = true;
    }
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
    Literal { span: String, value_kind: &'static str },
    Ident { name: String, span: String },
    Init { span: String },
    Import { source: String, imported: String, span: String },
    Member { span: String },
    ObjectProp { key: String, span: String },
    ArrayElem { index: usize, span: String },
    Call {
        callee: String,
        callsite: String,
        callee_span: String,
        fn_def_span: Option<String>,
    },
    Ctor { callee: String, span: String },
    Op { op: String, span: String },
    Env { key: String, span: String },
    Fetch { url: Option<String>, span: String },
    Context { name: String, span: String },
    Hook { name: String, span: String },
    Unknown { span: String },
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
            JSXElementName::Ident(Ident::new(self.provider_ident.clone().into(), DUMMY_SP, SyntaxContext::empty()).into());

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
                    key: PropName::Ident(IdentName::new("cs".into(), DUMMY_SP)),
                    value: Box::new(Expr::Lit(Lit::Str(Str {
                        span: DUMMY_SP,
                        value: meta.cs.into(),
                        raw: None,
                    }))),
                }))),
                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                    key: PropName::Ident(IdentName::new("c".into(), DUMMY_SP)),
                    value: Box::new(Expr::Lit(Lit::Str(Str {
                        span: DUMMY_SP,
                        value: meta.c.into(),
                        raw: None,
                    }))),
                }))),
                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                    key: PropName::Ident(IdentName::new("k".into(), DUMMY_SP)),
                    value: Box::new(Expr::Lit(Lit::Str(Str {
                        span: DUMMY_SP,
                        value: meta.k.into(),
                        raw: None,
                    }))),
                }))),
                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                    key: PropName::Ident(IdentName::new("fp".into(), DUMMY_SP)),
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
            name: JSXAttrName::Ident(IdentName::new("value".into(), DUMMY_SP)),
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
                    name: JSXElementName::Ident(Ident::new("div".into(), DUMMY_SP, SyntaxContext::empty()).into()),
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
        // Inject inline provider once per module
        self.ensure_provider_inline(m);
        m.visit_mut_children_with(self);
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
                cm.lookup_char_pos(orig_full_span.lo()).file.name.to_string()
            }
        } else {
            "unknown".to_string()
        };

        // Preserve your original attribute on EVERY JSX element
        node.opening
            .attrs
            .push(self.create_encoded_path_attr(&filename, node.opening.span, Some(node.span)));

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
                        }
                    }
                }
                JSXAttrOrSpread::SpreadElement(sp) => {
                    let mut chain = vec![];
                    let mut seen: HashSet<Id> = HashSet::new();
                    self.trace_expr(&sp.expr, &mut chain, 0, &mut seen);
                    all_nodes.extend(chain);
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
                let already = candidates.iter().any(|c| c.reason == "callsite" && c.target == self_target);
                if !already {
                    let cs = Candidate { target: self_target, reason: "callsite".into() };
                    // candidates.insert(0, cs);
                    candidates.push(cs);
                }
            }
        }

        let cands_json = serde_json::to_string(&candidates).unwrap_or_else(|_| "[]".into());
        let kinds_json = serde_json::to_string(&kinds).unwrap_or_else(|_| "[]".into());
        let cands_enc = xor_encode(&cands_json);
        let kinds_enc = xor_encode(&kinds_json);

        // Always-on behavior for custom component callsites:
        let is_custom_call = !is_host && Self::is_custom_component_name(&node.opening.name);

        if is_custom_call {
            // DOM wrapper (display: contents) carrying callsite; we also duplicate metadata on the invocation
            let mut wrapper =
                self.make_display_contents_wrapper(&filename, orig_open_span, orig_full_span);

            let mut original = std::mem::replace(
                node,
                JSXElement {
                    span: DUMMY_SP,
                    opening: JSXOpeningElement {
                        name: JSXElementName::Ident(Ident::new("div".into(), DUMMY_SP, SyntaxContext::empty()).into()),
                        attrs: vec![],
                        self_closing: false,
                        type_args: None,
                        span: DUMMY_SP,
                    },
                    children: vec![],
                    closing: None,
                },
            );

            // Duplicate metadata on invocation
            CodePressTransform::attach_attr_string(
                &mut original.opening.attrs,
                "data-codepress-edit-candidates",
                cands_enc.clone(),
            );
            CodePressTransform::attach_attr_string(
                &mut original.opening.attrs,
                "data-codepress-source-kinds",
                kinds_enc.clone(),
            );
            if let JSXAttrOrSpread::JSXAttr(a) =
                self.create_encoded_path_attr(&filename, orig_open_span, Some(orig_full_span))
            {
                original.opening.attrs.push(JSXAttrOrSpread::JSXAttr(JSXAttr {
                    span: DUMMY_SP,
                    name: JSXAttrName::Ident(IdentName::new(
                        "data-codepress-callsite".into(),
                        DUMMY_SP,
                    )),
                    value: a.value,
                }));
            }

            wrapper
                .children
                .push(JSXElementChild::JSXElement(Box::new(original)));
            *node = wrapper;

            // Also wrap with non-DOM Provider carrying same payload (context crosses portals, no DOM added)
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

            let attrs = &mut node.opening.attrs;
            CodePressTransform::attach_attr_string(attrs, "data-codepress-edit-candidates", cands_enc.clone());
            CodePressTransform::attach_attr_string(attrs, "data-codepress-source-kinds",  kinds_enc.clone());
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
            if let JSXAttrOrSpread::JSXAttr(a) =
                self.create_encoded_path_attr(&filename, node.opening.span, Some(node.span))
            {
                node.opening.attrs.push(JSXAttrOrSpread::JSXAttr(JSXAttr {
                    span: DUMMY_SP,
                    name: JSXAttrName::Ident(IdentName::new(
                        "data-codepress-callsite".into(),
                        DUMMY_SP,
                    )),
                    value: a.value,
                }));
            }
            CodePressTransform::attach_attr_string(&mut node.opening.attrs, "data-codepress-edit-candidates", cands_enc.clone());
            CodePressTransform::attach_attr_string(&mut node.opening.attrs, "data-codepress-source-kinds",  kinds_enc.clone());
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
            name: JSXAttrName::Ident(IdentName::new(key.into(), DUMMY_SP)),
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
pub fn process_transform(mut program: Program, metadata: TransformPluginProgramMetadata) -> Program {
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
