use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use swc_core::ecma::{
    ast::*,
    visit::{VisitMut, VisitMutWith},
};
use swc_core::plugin::{plugin_transform, proxies::TransformPluginProgramMetadata};
use swc_core::common::{SourceMapper, DUMMY_SP};

// Global flag to ensure repo/branch attributes are added only once
static GLOBAL_ATTRIBUTES_ADDED: AtomicBool = AtomicBool::new(false);

/// XOR encodes a string with a simple key
fn xor_encode(input: &str, key: u8) -> String {
    let xored: Vec<u8> = input.bytes().map(|b| b ^ key).collect();
    let base64_encoded = STANDARD.encode(xored);
    base64_encoded
        .replace('+', "-")
        .replace('/', "_")
        .replace('=', "")
}

pub struct CodePressTransform {
    repo_name: Option<String>,
    branch_name: Option<String>,
    source_map: Option<std::sync::Arc<dyn SourceMapper>>,
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

        Self {
            repo_name,
            branch_name,
            source_map,
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
        let encoded_path = xor_encode(filename, 42);
        
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

#[plugin_transform]
pub fn process_transform(mut program: Program, metadata: TransformPluginProgramMetadata) -> Program {
    let config = metadata
        .get_transform_plugin_config()
        .map(|s| serde_json::from_str(&s).unwrap_or_default())
        .unwrap_or_default();

    // Convert PluginSourceMapProxy to Arc<dyn SourceMapper>
    let source_map: Option<std::sync::Arc<dyn SourceMapper>> = Some(std::sync::Arc::new(metadata.source_map));

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
        let encoded = xor_encode(input, 42);
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