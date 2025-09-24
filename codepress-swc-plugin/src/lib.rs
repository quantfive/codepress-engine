use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use swc_core::{
    common::{SourceMapper, Spanned, SyntaxContext, DUMMY_SP},
    ecma::{
        ast::{
            Expr, ExprOrSpread, Id, Ident, IdentName, ImportPhase, Lit, MemberProp, OptChainBase,
            OptChainExpr, *,
        },
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

    // -------- module graph (this module only) --------
    module_file: Option<String>,
    graph: ModuleGraph,
    host_attr_stack: Vec<*mut Vec<JSXAttrOrSpread>>,
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
            module_file: None,
            graph: ModuleGraph {
                imports: vec![],
                exports: vec![],
                reexports: vec![],
                defs: vec![],
                mutations: vec![],
                literal_index: vec![],
                local_refs: vec![],
                local_derives: vec![],
            },
            host_attr_stack: Vec::new(),
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
    fn push_local_ref(&mut self, name: &str, kind: &'static str, span: swc_core::common::Span) {
        let _ = self.file_from_span(span);
        self.graph.local_refs.push(LocalRefRow {
            local: name.to_string(),
            kind,
            span: self.span_file_lines(span),
        });
    }

    /// Collect *identifier* names present inside an expression (shallow walk that skips JSX idents).
    fn collect_ident_names_in_expr(&self, e: &Expr, out: &mut BTreeSet<String>) {
        struct IdWalker<'a> { out: &'a mut BTreeSet<String> }
        impl<'a> Visit for IdWalker<'a> {
            fn visit_ident(&mut self, n: &Ident) { self.out.insert(n.sym.to_string()); }
        }
        e.visit_with(&mut IdWalker { out });
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
                    callee: Box::new(Expr::Ident(Ident::new(
                        "Function".into(),
                        DUMMY_SP,
                        SyntaxContext::empty(),
                    ))),
                    args: Some(vec![ExprOrSpread {
                        spread: None,
                        expr: Box::new(Expr::Lit(Lit::Str(Str {
                            span: DUMMY_SP,
                            value: js.into(),
                            raw: None,
                        }))),
                    }]),
                    type_args: None,
                    ctxt: SyntaxContext::empty(),
                }))),
                args: vec![],
                type_args: None,
                ctxt: SyntaxContext::empty(),
            })),
        }));
        m.body.insert(0, stmt);
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
    fn set_attr_string(attrs: &mut Vec<JSXAttrOrSpread>, key: &str, val: String) {
        // remove existing then push
        attrs.retain(|a| {
            !matches!(a, JSXAttrOrSpread::JSXAttr(jsx)
            if matches!(&jsx.name, JSXAttrName::Ident(id) if id.sym.as_ref()==key))
        });
        Self::attach_attr_string(attrs, key, val);
    }
    /// Merge two JSON-array strings without parsing. Accepts "[]" or "[...]" strings.
    /// If either side is empty or malformed, falls back to concat or the non-empty side.
    fn merge_json_arrays_str(lhs: &str, rhs: &str) -> String {
        let l = lhs.trim();
        let r = rhs.trim();
        let empty_l = l == "[]" || l.is_empty();
        let empty_r = r == "[]" || r.is_empty();
        if empty_l && empty_r {
            return "[]".to_string();
        }
        if empty_l {
            return r.to_string();
        }
        if empty_r {
            return l.to_string();
        }
        // strip brackets
        let l_body = l
            .strip_prefix('[')
            .and_then(|x| x.strip_suffix(']'))
            .unwrap_or(l);
        let r_body = r
            .strip_prefix('[')
            .and_then(|x| x.strip_suffix(']'))
            .unwrap_or(r);
        if l_body.is_empty() {
            return format!("[{}]", r_body);
        }
        if r_body.is_empty() {
            return format!("[{}]", l_body);
        }
        format!("[{},{}]", l_body, r_body)
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
            Expr::TaggedTpl(tt) => {
                chain.push(ProvNode::Op {
                    op: "tagged-template".into(),
                    span: self.span_file_lines(tt.span),
                });
                self.trace_expr(&tt.tag, chain, depth + 1, seen);
                for ex in &tt.tpl.exprs {
                    self.trace_expr(ex, chain, depth + 1, seen);
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

    fn push_ident_ref(
        &mut self,
        i: &Ident,
        path: Option<String>,
        span: swc_core::common::Span,
        out: &mut Vec<SymbolRef>,
    ) {
        let file = self
            .file_from_span(span)
            .unwrap_or_else(|| self.current_file());
        out.push(SymbolRef {
            file,
            local: i.sym.to_string(),
            path: path.unwrap_or_default(),
            span: self.span_file_lines(span),
        });

        // chase initializer exactly once
        if let Some(init) = self
            .bindings
            .get(&i.to_id())
            .and_then(|b| b.init.as_deref())
            .cloned()
        {
            self.collect_symbol_refs_from_expr(&init, out);
        }
    }

    fn member_to_root_and_path(
        &mut self,
        e: &Expr,
    ) -> Option<(Ident, String, swc_core::common::Span)> {
        use swc_core::ecma::ast::*;

        fn push_seg(path: &mut String, seg: &str, bracketed: bool) {
            if bracketed {
                path.push('[');
                path.push_str(seg);
                path.push(']');
            } else {
                if !path.is_empty() {
                    path.push('.');
                }
                path.push_str(seg);
            }
        }

        // Normalize optional chains to a Member if possible
        if let Expr::OptChain(OptChainExpr { base, .. }) = e {
            match &**base {
                OptChainBase::Member(m) => {
                    // Convert to a plain Member and reuse the same logic
                    let mem = Expr::Member(m.clone());
                    return self.member_to_root_and_path(&mem);
                }
                OptChainBase::Call(c) => {
                    // `callee` is Box<Expr>` here as well
                    let callee_expr: &Expr = &*c.callee;
                    if let Some((root, _p, sp)) = self.member_to_root_and_path(callee_expr) {
                        return Some((root, String::new(), sp));
                    }
                    return None;
                }
            }
        }

        // Regular MemberExpr
        if let Expr::Member(m) = e {
            // Walk object to find the root identifier (m.obj: Box<Expr>)
            let (root, mut path, root_span) = match &*m.obj {
                Expr::Ident(id) => (id.clone(), String::new(), id.span),
                obj_expr => {
                    if let Some((rid, p, rs)) = self.member_to_root_and_path(obj_expr) {
                        (rid, p, rs)
                    } else {
                        return None;
                    }
                }
            };

            // Append a static segment if possible
            match &m.prop {
                MemberProp::Ident(p) => {
                    push_seg(&mut path, &p.sym, false);
                }
                MemberProp::Computed(c) => {
                    match &*c.expr {
                        Expr::Lit(Lit::Str(s)) => {
                            push_seg(&mut path, &format!("{:?}", s.value), true)
                        }
                        Expr::Lit(Lit::Num(n)) => push_seg(&mut path, &n.value.to_string(), true),
                        Expr::Ident(p) => push_seg(&mut path, &p.sym, true),
                        _ => {} // dynamic index; keep partial
                    }
                }
                MemberProp::PrivateName(_) => { /* ignore as a segment */ }
            }
            return Some((root, path, root_span));
        }

        None
    }

    fn collect_symbol_refs_from_expr(&mut self, e: &Expr, out: &mut Vec<SymbolRef>) {
        use swc_core::ecma::ast::*;

        match e {
            Expr::Ident(i) => {
                self.push_ident_ref(i, None, i.span, out);
                // mark plain identifier usage in expressions
                self.push_local_ref(&i.sym.to_string(), "expr", i.span());
            }

            Expr::Member(_) | Expr::OptChain(_) => {
                if let Some((root, path, sp)) = self.member_to_root_and_path(e) {
                    let p = if path.is_empty() { None } else { Some(path) };
                    self.push_ident_ref(&root, p, sp, out);
                }
            }

            Expr::Call(c) => {
                if let swc_core::ecma::ast::Callee::Expr(expr) = &c.callee {
                    match &**expr {
                        Expr::Member(_) | Expr::OptChain(_) => {
                            if let Some((root, _path, sp)) = self.member_to_root_and_path(&**expr) {
                                self.push_ident_ref(&root, None, sp, out);
                            } else {
                                self.collect_symbol_refs_from_expr(&**expr, out);
                            }
                        }
                        _ => self.collect_symbol_refs_from_expr(&**expr, out),
                    }
                }
                for a in &c.args {
                    self.collect_symbol_refs_from_expr(&a.expr, out);
                }
            }

            Expr::New(n) => {
                self.collect_symbol_refs_from_expr(&n.callee, out);
                if let Some(args) = &n.args {
                    for a in args {
                        self.collect_symbol_refs_from_expr(&a.expr, out);
                    }
                }
            }

            Expr::Tpl(t) => {
                for ex in &t.exprs {
                    // record template interpolation idents as "template"
                    let mut ids = BTreeSet::<String>::new();
                    self.collect_ident_names_in_expr(ex, &mut ids);
                    for name in ids.iter() {
                        self.push_local_ref(name, "template", ex.span());
                    }
                    self.collect_symbol_refs_from_expr(ex, out);
                }
            }

            Expr::TaggedTpl(tt) => {
                self.collect_symbol_refs_from_expr(&tt.tag, out);
                for ex in &tt.tpl.exprs {
                    self.collect_symbol_refs_from_expr(ex, out);
                }
            }

            Expr::Bin(b) => {
                self.collect_symbol_refs_from_expr(&b.left, out);
                self.collect_symbol_refs_from_expr(&b.right, out);
            }
            Expr::Unary(u) => self.collect_symbol_refs_from_expr(&u.arg, out),
            Expr::Update(u) => self.collect_symbol_refs_from_expr(&u.arg, out),
            Expr::Cond(c) => {
                self.collect_symbol_refs_from_expr(&c.test, out);
                self.collect_symbol_refs_from_expr(&c.cons, out);
                self.collect_symbol_refs_from_expr(&c.alt, out);
            }
            Expr::Seq(s) => {
                for x in &s.exprs {
                    self.collect_symbol_refs_from_expr(x, out);
                }
            }
            Expr::Paren(p) => self.collect_symbol_refs_from_expr(&p.expr, out),

            Expr::Array(a) => {
                for el in &a.elems {
                    if let Some(ExprOrSpread { expr, .. }) = el {
                        self.collect_symbol_refs_from_expr(expr, out);
                    }
                }
            }

            Expr::Object(o) => {
                for p in &o.props {
                    match p {
                        PropOrSpread::Spread(s) => self.collect_symbol_refs_from_expr(&s.expr, out),
                        PropOrSpread::Prop(pp) => match &**pp {
                            Prop::KeyValue(kv) => {
                                if let PropName::Computed(c) = &kv.key {
                                    self.collect_symbol_refs_from_expr(&c.expr, out);
                                }
                                self.collect_symbol_refs_from_expr(&kv.value, out);
                            }
                            Prop::Method(_) | Prop::Getter(_) | Prop::Setter(_) => { /* skip */ }
                            Prop::Shorthand(id) => self.push_ident_ref(id, None, id.span, out),
                            _ => {}
                        },
                    }
                }
            }

            // TS wrappers
            Expr::TsAs(e) => self.collect_symbol_refs_from_expr(&e.expr, out),
            Expr::TsTypeAssertion(e) => self.collect_symbol_refs_from_expr(&e.expr, out),
            Expr::TsConstAssertion(e) => self.collect_symbol_refs_from_expr(&e.expr, out),
            Expr::TsNonNull(e) => self.collect_symbol_refs_from_expr(&e.expr, out),
            Expr::TsSatisfies(e) => self.collect_symbol_refs_from_expr(&e.expr, out),

            // No refs
            Expr::Lit(_) | Expr::This(_) | Expr::MetaProp(_) | Expr::PrivateName(_) => {}

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
            name: JSXElementName::Ident(
                Ident::new(
                    self.wrapper_tag.clone().into(),
                    DUMMY_SP,
                    SyntaxContext::empty(),
                )
                .into(),
            ),
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
                    props: vec![PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                        key: PropName::Ident(IdentName::new("display".into(), DUMMY_SP)),
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
                name: JSXAttrName::Ident(IdentName::new(
                    "data-codepress-callsite".into(),
                    DUMMY_SP,
                )),
                value: a.value,
            }));
        }
        JSXElement {
            span: DUMMY_SP,
            opening,
            children: vec![],
            closing: Some(JSXClosingElement {
                span: DUMMY_SP,
                name: JSXElementName::Ident(
                    Ident::new(
                        self.wrapper_tag.clone().into(),
                        DUMMY_SP,
                        SyntaxContext::empty(),
                    )
                    .into(),
                ),
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
                    obj: Box::new(Expr::Ident(Ident::new(
                        "__CPX".into(),
                        DUMMY_SP,
                        SyntaxContext::empty(),
                    ))),
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
                            key: Ident::new("value".into(), DUMMY_SP, SyntaxContext::empty())
                                .into(),
                            value: None,
                        }),
                        ObjectPatProp::Assign(AssignPatProp {
                            span: DUMMY_SP,
                            key: Ident::new("children".into(), DUMMY_SP, SyntaxContext::empty())
                                .into(),
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
                        obj: JSXObject::Ident(Ident::new(
                            "__CPX".into(),
                            DUMMY_SP,
                            SyntaxContext::empty(),
                        )),
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
                        obj: JSXObject::Ident(Ident::new(
                            "__CPX".into(),
                            DUMMY_SP,
                            SyntaxContext::empty(),
                        )),
                        prop: IdentName::new("Provider".into(), DUMMY_SP),
                    }),
                }),
            };
            ModuleItem::Stmt(Stmt::Decl(Decl::Fn(FnDecl {
                ident: Ident::new(
                    self.provider_ident.clone().into(),
                    DUMMY_SP,
                    SyntaxContext::empty(),
                ),
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
struct LocalRefRow {
    local: String,      // the locally-bound name you used in this file
    kind: &'static str, // "expr" | "jsx-tag" | "jsx-prop" | "template"
    span: String,       // "file:start-end"
}

#[derive(serde::Serialize)]
struct LocalDeriveRow {
    lhs: String,       // new local being defined
    from: Vec<String>, // locals referenced in the initializer
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
    local_refs: Vec<LocalRefRow>,
    local_derives: Vec<LocalDeriveRow>,
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
        let provider_name: JSXElementName = JSXElementName::Ident(
            Ident::new(
                self.provider_ident.clone().into(),
                DUMMY_SP,
                SyntaxContext::empty(),
            )
            .into(),
        );

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
                    name: JSXElementName::Ident(
                        Ident::new("div".into(), DUMMY_SP, SyntaxContext::empty()).into(),
                    ),
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

    // Only scan this element’s own opening attrs and direct JSXExpr children.
    fn collect_shallow_from_jsx_element(&mut self, el: &JSXElement, symrefs: &mut Vec<SymbolRef>) {
        // opening attrs (no nested JSX)
        for a in &el.opening.attrs {
            if let JSXAttrOrSpread::JSXAttr(attr) = a {
                if let Some(JSXAttrValue::JSXExprContainer(c)) = &attr.value {
                    if let JSXExpr::Expr(expr) = &c.expr {
                        self.collect_symbol_refs_from_expr(expr, symrefs);
                    }
                } else if let Some(JSXAttrValue::JSXFragment(_))
                | Some(JSXAttrValue::JSXElement(_)) = &attr.value
                {
                    // skip nested JSX in shallow mode
                }
            } else if let JSXAttrOrSpread::SpreadElement(sp) = a {
                self.collect_symbol_refs_from_expr(&sp.expr, symrefs);
            }
        }

        // direct children that are expressions (skip nested <JSXElement> / fragments)
        for ch in &el.children {
            if let JSXElementChild::JSXExprContainer(c) = ch {
                if let JSXExpr::Expr(expr) = &c.expr {
                    self.collect_symbol_refs_from_expr(expr, symrefs);
                }
            }
        }
    }

    fn collect_from_jsx_element(
        &mut self,
        el: &JSXElement,
        all_nodes: &mut Vec<ProvNode>,
        symrefs: &mut Vec<SymbolRef>,
    ) {
        // record tag identifier usage (custom/local components) as "jsx-tag"
        if let JSXElementName::Ident(tag_ident) = &el.opening.name {
            // Uppercase heuristic usually means local binding (Component)
            self.push_local_ref(&tag_ident.sym.to_string(), "jsx-tag", tag_ident.span);
        }
        // 1) attributes on this element
        for a in &el.opening.attrs {
            match a {
                JSXAttrOrSpread::JSXAttr(attr) => match &attr.value {
                    Some(JSXAttrValue::JSXExprContainer(c)) => {
                        if let JSXExpr::Expr(expr) = &c.expr {
                            // mark idents inside JSX prop expressions
                            let mut ids = BTreeSet::<String>::new();
                            self.collect_ident_names_in_expr(expr, &mut ids);
                            for name in ids.iter() {
                                self.push_local_ref(name, "jsx-prop", expr.span());
                            }

                            let expr = &**expr;
                            let mut chain = vec![];
                            let mut seen = HashSet::<Id>::new();
                            self.trace_expr(expr, &mut chain, 0, &mut seen);
                            all_nodes.extend(chain);
                            self.collect_symbol_refs_from_expr(expr, symrefs);
                        }
                    }
                    Some(JSXAttrValue::JSXElement(inner)) => {
                        self.collect_from_jsx_element(inner, all_nodes, symrefs);
                    }
                    Some(JSXAttrValue::JSXFragment(frag)) => {
                        self.collect_from_jsx_fragment(frag, all_nodes, symrefs);
                    }
                    _ => {}
                },
                JSXAttrOrSpread::SpreadElement(sp) => {
                    // spread child expression local refs
                    let mut ids = BTreeSet::<String>::new();
                    self.collect_ident_names_in_expr(&sp.expr, &mut ids);
                    for name in ids.iter() {
                        self.push_local_ref(name, "jsx-prop", sp.span());
                    }

                    let mut chain = vec![];
                    let mut seen = HashSet::<Id>::new();
                    self.trace_expr(&sp.expr, &mut chain, 0, &mut seen);
                    all_nodes.extend(chain);
                    self.collect_symbol_refs_from_expr(&sp.expr, symrefs);
                }
            }
        }

        // 2) children of this element
        for ch in &el.children {
            match ch {
                JSXElementChild::JSXExprContainer(c) => {
                    if let JSXExpr::Expr(expr) = &c.expr {
                        let expr = &**expr;
                        let mut chain = vec![];
                        let mut seen = HashSet::<Id>::new();
                        self.trace_expr(expr, &mut chain, 0, &mut seen);
                        all_nodes.extend(chain);
                        self.collect_symbol_refs_from_expr(expr, symrefs);
                    }
                }
                JSXElementChild::JSXElement(inner) => {
                    self.collect_from_jsx_element(inner, all_nodes, symrefs);
                }
                JSXElementChild::JSXFragment(frag) => {
                    self.collect_from_jsx_fragment(frag, all_nodes, symrefs);
                }
                JSXElementChild::JSXSpreadChild(sp) => {
                    let mut chain = vec![];
                    let mut seen = HashSet::<Id>::new();
                    self.trace_expr(&sp.expr, &mut chain, 0, &mut seen);
                    all_nodes.extend(chain);
                    self.collect_symbol_refs_from_expr(&sp.expr, symrefs);
                }
                JSXElementChild::JSXText(t) => {
                    all_nodes.push(ProvNode::Literal {
                        span: self.span_file_lines(t.span),
                        value_kind: "string",
                    });
                }
            }
        }
    }

    fn collect_from_jsx_fragment(
        &mut self,
        frag: &JSXFragment,
        all_nodes: &mut Vec<ProvNode>,
        symrefs: &mut Vec<SymbolRef>,
    ) {
        for ch in &frag.children {
            match ch {
                JSXElementChild::JSXExprContainer(c) => {
                    if let JSXExpr::Expr(expr) = &c.expr {
                        let expr = &**expr;
                        let mut chain = vec![];
                        let mut seen = HashSet::<Id>::new();
                        self.trace_expr(expr, &mut chain, 0, &mut seen);
                        all_nodes.extend(chain);
                        self.collect_symbol_refs_from_expr(expr, symrefs);
                    }
                }
                JSXElementChild::JSXElement(inner) => {
                    self.collect_from_jsx_element(inner, all_nodes, symrefs);
                }
                JSXElementChild::JSXFragment(f) => {
                    self.collect_from_jsx_fragment(f, all_nodes, symrefs);
                }
                JSXElementChild::JSXSpreadChild(sp) => {
                    let mut chain = vec![];
                    let mut seen = HashSet::<Id>::new();
                    self.trace_expr(&sp.expr, &mut chain, 0, &mut seen);
                    all_nodes.extend(chain);
                    self.collect_symbol_refs_from_expr(&sp.expr, symrefs);
                }
                JSXElementChild::JSXText(t) => {
                    all_nodes.push(ProvNode::Literal {
                        span: self.span_file_lines(t.span),
                        value_kind: "string",
                    });
                }
            }
        }
    }
}

impl VisitMut for CodePressTransform {
    fn visit_mut_module(&mut self, m: &mut Module) {
        // Inject inline provider once per module
        self.ensure_provider_inline(m);
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
            // localDerives — LHS depends on idents in initializer
            if let Some(init) = &d.init {
                let mut ids = BTreeSet::<String>::new();
                self.collect_ident_names_in_expr(init, &mut ids);
                if !ids.is_empty() {
                    let _ = self.file_from_span(d.span);
                    self.graph.local_derives.push(LocalDeriveRow {
                        lhs: name.id.sym.to_string(),
                        from: ids.into_iter().collect(),
                        span: self.span_file_lines(d.span),
                    });
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
        // Determine if this node is a host before descending
        let is_host_pre = matches!(
            &node.opening.name,
            JSXElementName::Ident(id) if id.sym.chars().next().map(|c| c.is_lowercase()).unwrap_or(false)
        );
        if is_host_pre {
            // SAFETY: we only deref within this call frame, and SWC visits depth-first
            let attrs_ptr: *mut Vec<JSXAttrOrSpread> = &mut node.opening.attrs;
            self.host_attr_stack.push(attrs_ptr);
        }

        node.visit_mut_children_with(self);

        // Skip our synthetic elements to avoid computing spans on DUMMY_SP, but still visit inside.
        if self.is_synthetic_element(&node.opening.name) {
            if is_host_pre {
                self.host_attr_stack.pop();
            }
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
        node.opening.attrs.push(self.create_encoded_path_attr(
            &filename,
            node.opening.span,
            Some(node.span),
        ));

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
        let is_host = is_host_pre;

        // ---------- gather provenance for this element ----------
        let mut all_nodes: Vec<ProvNode> = vec![];
        let mut symrefs: Vec<SymbolRef> = vec![];

        // Deep walk: this element + any nested JSX inside attrs/children
        self.collect_from_jsx_element(node, &mut all_nodes, &mut symrefs);

        // shallow (callsite-only)
        let mut symrefs_shallow: Vec<SymbolRef> = vec![];
        self.collect_shallow_from_jsx_element(node, &mut symrefs_shallow);

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
        let symrefs_shallow_json =
            serde_json::to_string(&symrefs_shallow).unwrap_or_else(|_| "[]".into());
        let symrefs_enc = xor_encode(&symrefs_json);
        let cs_symrefs_enc = xor_encode(&symrefs_shallow_json);

        // Always-on behavior for custom component callsites:
        let is_custom_call = !is_host && Self::is_custom_component_name(&node.opening.name);

        if is_custom_call {
            // 1) Leave DEEP refs on the invocation (unchanged)
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

            // 2) Stamp SHALLOW call-site refs on the nearest host ancestor in the caller.
            if let Some(host_attrs_ptr) = self.host_attr_stack.last().copied() {
                // SAFETY: pointer is valid within this visit frame
                let host_attrs: &mut Vec<JSXAttrOrSpread> = unsafe { &mut *host_attrs_ptr };
                // MERGE SHALLOW (not overwrite) callsite refs
                if let Some(existing) =
                    Self::get_attr_string(host_attrs, "data-codepress-callsite-symbol-refs")
                {
                    let merged = Self::merge_json_arrays_str(&existing, &cs_symrefs_enc);
                    Self::set_attr_string(
                        host_attrs,
                        "data-codepress-callsite-symbol-refs",
                        merged,
                    );
                } else {
                    Self::attach_attr_string(
                        host_attrs,
                        "data-codepress-callsite-symbol-refs",
                        cs_symrefs_enc.clone(),
                    );
                }
                // MERGE DEEP refs into host
                if let Some(existing) =
                    Self::get_attr_string(host_attrs, "data-codepress-symbol-refs")
                {
                    let merged = Self::merge_json_arrays_str(&existing, &symrefs_enc);
                    Self::set_attr_string(host_attrs, "data-codepress-symbol-refs", merged);
                } else {
                    Self::attach_attr_string(
                        host_attrs,
                        "data-codepress-symbol-refs",
                        symrefs_enc.clone(),
                    );
                }
                // stamp/merge callsite location too (file:start-end)
                if let JSXAttrOrSpread::JSXAttr(a) =
                    self.create_encoded_path_attr(&filename, orig_open_span, Some(orig_full_span))
                {
                    let key = "data-codepress-callsite";
                    if let Some(existing) = Self::get_attr_string(host_attrs, key) {
                        // locations are single strings; keep first (stable) and ignore duplicates
                        // No-op if already set
                        let _ = existing;
                    } else {
                        host_attrs.push(JSXAttrOrSpread::JSXAttr(JSXAttr {
                            span: DUMMY_SP,
                            name: JSXAttrName::Ident(IdentName::new(key.into(), DUMMY_SP)),
                            value: a.value,
                        }));
                    }
                }
            } else {
                // 2b) No host ancestor available. Introduce a TEMP wrapper (display:contents)
                //     that carries call-site refs; Pass 2 (HoistAndElide) will hoist them into
                //     the first host descendant and remove the wrapper => no extra DOM ends up in output.
                let mut wrapper =
                    self.make_display_contents_wrapper(&filename, orig_open_span, orig_full_span);
                CodePressTransform::attach_attr_string(
                    &mut wrapper.opening.attrs,
                    "data-codepress-callsite-symbol-refs",
                    cs_symrefs_enc.clone(),
                );
                CodePressTransform::attach_attr_string(
                    &mut wrapper.opening.attrs,
                    "data-codepress-symbol-refs",
                    symrefs_enc.clone(),
                );
                // move current node into wrapper children
                let original = std::mem::replace(
                    node,
                    JSXElement {
                        span: DUMMY_SP,
                        opening: JSXOpeningElement {
                            name: JSXElementName::Ident(
                                Ident::new("div".into(), DUMMY_SP, SyntaxContext::empty()).into(),
                            ),
                            attrs: vec![],
                            self_closing: false,
                            type_args: None,
                            span: DUMMY_SP,
                        },
                        children: vec![],
                        closing: None,
                    },
                );
                wrapper
                    .children
                    .push(JSXElementChild::JSXElement(Box::new(original)));
                *node = wrapper;
            }

            // 3) wrap with non-DOM Provider carrying same payload (context crosses portals, no DOM added)
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
                sr: symrefs_enc.clone(),
                csr: cs_symrefs_enc.clone(),
            };
            self.wrap_with_provider(node, meta);
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
            CodePressTransform::attach_attr_string(
                &mut node.opening.attrs,
                "data-codepress-callsite-symbol-refs",
                cs_symrefs_enc.clone(),
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
        }
        if is_host_pre {
            self.host_attr_stack.pop();
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
    fn is_host(el: &JSXElement) -> bool {
        matches!(
            &el.opening.name,
            JSXElementName::Ident(id) if id.sym.chars().next().map(|c| c.is_lowercase()).unwrap_or(false)
        )
    }

    // returns Some(&mut JSXElement) of the first host descendant, depth-first
    fn first_host_descendant_mut<'a>(el: &'a mut JSXElement) -> Option<&'a mut JSXElement> {
        for ch in &mut el.children {
            if let JSXElementChild::JSXElement(inner) = ch {
                if Self::is_host(inner) {
                    return Some(inner);
                }
                if let Some(d) = Self::first_host_descendant_mut(inner) {
                    return Some(d);
                }
            }
        }
        None
    }
    fn remove_attr(attrs: &mut Vec<JSXAttrOrSpread>, key: &str) {
        attrs.retain(|a| {
            if let JSXAttrOrSpread::JSXAttr(attr) = a {
                if let JSXAttrName::Ident(id) = &attr.name {
                    return id.sym.as_ref() != key;
                }
            }
            true
        });
    }
    fn copy_payload_keys(
        src_attrs: &[JSXAttrOrSpread],
        dst_attrs: &mut Vec<JSXAttrOrSpread>,
        keys: &[String],
    ) {
        for key in keys {
            if let Some(val) = Self::get_attr_string(src_attrs, key) {
                // For JSON-array ref keys, MERGE instead of overwrite
                if key == "data-codepress-callsite-symbol-refs"
                    || key == "data-codepress-symbol-refs"
                {
                    if let Some(existing) = Self::get_attr_string(dst_attrs, key) {
                        let merged = CodePressTransform::merge_json_arrays_str(&existing, &val);
                        Self::remove_attr(dst_attrs, key);
                        Self::push_attr(dst_attrs, key, merged);
                    } else {
                        Self::push_attr(dst_attrs, key, val);
                    }
                } else {
                    // For non-array payloads, keep first writer
                    if !Self::has_attr(dst_attrs, key) {
                        Self::push_attr(dst_attrs, key, val);
                    }
                }
            }
        }
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
        // 1) Prefer to hoist payload into the nearest host DOM descendant.
        if let Some(host) = Self::first_host_descendant_mut(&mut child) {
            Self::copy_payload_keys(&node.opening.attrs, &mut host.opening.attrs, &self.keys);
        } else {
            // 2) No host descendant available here (likely a custom component invocation).
            //    Hoist payload as props to the child invocation itself (these will land
            //    on real DOM if the component forwards props).
            Self::copy_payload_keys(&node.opening.attrs, &mut child.opening.attrs, &self.keys);
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
            "data-codepress-callsite-symbol-refs".to_string(),
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
    sr: String,
    csr: String,
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
