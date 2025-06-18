// CodePress SWC Plugin - Rust implementation
// This plugin mirrors the functionality of the Babel plugin

use std::process::Command;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use once_cell::sync::Lazy;
use regex::Regex;
use swc_core::{
    common::{DUMMY_SP, SyntaxContext},
    ecma::{
        ast::*,
        atoms::Atom,
        visit::{noop_visit_mut_type, VisitMut, VisitMutWith, FoldWith, Fold},
    },
    plugin::{plugin_transform, metadata::TransformPluginProgramMetadata},
};

// Constants for encoding
const SECRET: &[u8] = b"codepress-file-obfuscation";

// Global state to track if repo/branch attributes have been added
static mut GLOBAL_ATTRIBUTES_ADDED: bool = false;

/// Configuration options for the plugin
#[derive(Debug, Clone)]
pub struct Config {
    pub attribute_name: String,
    pub repo_attribute_name: String,
    pub branch_attribute_name: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            attribute_name: "codepress-data-fp".to_string(),
            repo_attribute_name: "codepress-github-repo-name".to_string(),
            branch_attribute_name: "codepress-github-branch".to_string(),
        }
    }
}

/// XOR encode a relative path using the secret key
fn encode(rel_path: &str) -> String {
    if rel_path.is_empty() {
        return String::new();
    }
    
    let rel_path_bytes = rel_path.as_bytes();
    let mut xored = Vec::with_capacity(rel_path_bytes.len());
    
    for (i, &byte) in rel_path_bytes.iter().enumerate() {
        xored.push(byte ^ SECRET[i % SECRET.len()]);
    }
    
    URL_SAFE_NO_PAD.encode(xored)
}

/// Detects the current git branch
fn detect_git_branch() -> String {
    match Command::new("git")
        .args(&["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
    {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => {
            eprintln!("⚠ Could not detect git branch, using default: main");
            "main".to_string()
        }
    }
}

/// Detects the git repository name from remote URL
fn detect_git_repo_name() -> Option<String> {
    let output = Command::new("git")
        .args(&["config", "--get", "remote.origin.url"])
        .output()
        .ok()?;
    
    if !output.status.success() {
        return None;
    }
    
    let binding = String::from_utf8_lossy(&output.stdout);
    let remote_url = binding.trim();
    if remote_url.is_empty() {
        return None;
    }
    
    // Parse HTTPS URL format: https://github.com/owner/repo.git
    if let Ok(re) = Regex::new(r"https://github\.com/([^/]+)/([^/.]+)(?:\.git)?$") {
        if let Some(caps) = re.captures(remote_url) {
            let owner = caps.get(1)?.as_str();
            let repo = caps.get(2)?.as_str();
            let repo_id = format!("{}/{}", owner, repo);
            eprintln!("✓ Detected GitHub repository: {}", repo_id);
            return Some(repo_id);
        }
    }
    
    // Parse SSH URL format: git@github.com:owner/repo.git
    if let Ok(re) = Regex::new(r"git@github\.com:([^/]+)/([^/.]+)(?:\.git)?$") {
        if let Some(caps) = re.captures(remote_url) {
            let owner = caps.get(1)?.as_str();
            let repo = caps.get(2)?.as_str();
            let repo_id = format!("{}/{}", owner, repo);
            eprintln!("✓ Detected GitHub repository: {}", repo_id);
            return Some(repo_id);
        }
    }
    
    eprintln!("⚠ Could not parse GitHub repository from remote URL");
    None
}

// Lazy initialization of git info
static GIT_BRANCH: Lazy<String> = Lazy::new(detect_git_branch);
static GIT_REPO: Lazy<Option<String>> = Lazy::new(detect_git_repo_name);

/// Transform visitor that adds CodePress attributes to JSX elements
pub struct CodePressTransform {
    config: Config,
    current_file_path: String,
    encoded_path: String,
}

impl CodePressTransform {
    pub fn new(config: Config, filename: &str) -> Self {
        // Convert absolute path to relative path from cwd
        let current_file_path = if filename.starts_with('/') {
            // This is a simplified relative path calculation
            // In a real implementation, you'd want to use proper path manipulation
            filename.to_string()
        } else {
            filename.to_string()
        };
        
        // Skip node_modules files
        let encoded_path = if current_file_path.contains("node_modules") || current_file_path.is_empty() {
            String::new()
        } else {
            encode(&current_file_path)
        };
        
        Self {
            config,
            current_file_path,
            encoded_path,
        }
    }
    
    /// Create a JSX attribute with the given name and value
    fn create_jsx_attr(&self, name: &str, value: &str) -> JSXAttrOrSpread {
        JSXAttrOrSpread::JSXAttr(JSXAttr {
            span: DUMMY_SP,
            name: JSXAttrName::Ident(IdentName::new(Atom::from(name), DUMMY_SP)),
            value: Some(JSXAttrValue::Lit(Lit::Str(Str {
                span: DUMMY_SP,
                value: Atom::from(value),
                raw: None,
            }))),
        })
    }
    
    /// Check if an attribute with the given name exists
    fn has_attr(&self, attrs: &[JSXAttrOrSpread], name: &str) -> bool {
        attrs.iter().any(|attr| {
            if let JSXAttrOrSpread::JSXAttr(jsx_attr) = attr {
                if let JSXAttrName::Ident(ident) = &jsx_attr.name {
                    return ident.sym.as_ref() == name;
                }
            }
            false
        })
    }
    
    /// Update existing attribute value
    fn update_attr(&self, attrs: &mut [JSXAttrOrSpread], name: &str, value: &str) {
        for attr in attrs.iter_mut() {
            if let JSXAttrOrSpread::JSXAttr(jsx_attr) = attr {
                if let JSXAttrName::Ident(ident) = &jsx_attr.name {
                    if ident.sym.as_ref() == name {
                        jsx_attr.value = Some(JSXAttrValue::Lit(Lit::Str(Str {
                            span: DUMMY_SP,
                            value: Atom::from(value),
                            raw: None,
                        })));
                        break;
                    }
                }
            }
        }
    }
    
    /// Check if element is suitable for global attributes (html, body, div)
    fn is_suitable_element(&self, name: &JSXElementName) -> bool {
        if let JSXElementName::Ident(ident) = name {
            matches!(ident.sym.as_ref(), "html" | "body" | "div")
        } else {
            false
        }
    }
}

impl VisitMut for CodePressTransform {
    noop_visit_mut_type!();
    
    fn visit_mut_jsx_opening_element(&mut self, node: &mut JSXOpeningElement) {
        if self.encoded_path.is_empty() {
            return;
        }
        
        // Calculate line numbers from span
        let start_line = node.span.lo.0 as u32; // Simplified line calculation
        let end_line = node.span.hi.0 as u32;   // In real implementation, you'd use proper source map
        
        // Create attribute value with encoded path and line numbers
        let attribute_value = format!("{}:{}-{}", self.encoded_path, start_line, end_line);
        
        // Add or update the file path attribute
        if self.has_attr(&node.attrs, &self.config.attribute_name) {
            self.update_attr(&mut node.attrs, &self.config.attribute_name, &attribute_value);
        } else {
            node.attrs.push(self.create_jsx_attr(&self.config.attribute_name, &attribute_value));
        }
        
        // Add global repo and branch attributes if needed
        unsafe {
            if let Some(ref repo_name) = *GIT_REPO {
                if !GLOBAL_ATTRIBUTES_ADDED && self.is_suitable_element(&node.name) {
                    // Add repo attribute if not exists
                    if !self.has_attr(&node.attrs, &self.config.repo_attribute_name) {
                        eprintln!("✓ Adding repo attribute globally to element");
                        node.attrs.push(self.create_jsx_attr(&self.config.repo_attribute_name, repo_name));
                    }
                    
                    // Add branch attribute if not exists
                    if !self.has_attr(&node.attrs, &self.config.branch_attribute_name) {
                        eprintln!("✓ Adding branch attribute globally to element");
                        node.attrs.push(self.create_jsx_attr(&self.config.branch_attribute_name, &GIT_BRANCH));
                    }
                    
                    GLOBAL_ATTRIBUTES_ADDED = true;
                    eprintln!("ℹ Repo/branch attributes added globally. Won't add again.");
                }
            }
        }
        
        // Continue visiting child nodes
        node.visit_mut_children_with(self);
    }
}

impl Fold for CodePressTransform {
    fn fold_jsx_opening_element(&mut self, mut node: JSXOpeningElement) -> JSXOpeningElement {
        if self.encoded_path.is_empty() {
            return node;
        }
        
        // Calculate line numbers from span
        let start_line = node.span.lo.0 as u32; // Simplified line calculation
        let end_line = node.span.hi.0 as u32;   // In real implementation, you'd use proper source map
        
        // Create attribute value with encoded path and line numbers
        let attribute_value = format!("{}:{}-{}", self.encoded_path, start_line, end_line);
        
        // Add or update the file path attribute
        if self.has_attr(&node.attrs, &self.config.attribute_name) {
            self.update_attr(&mut node.attrs, &self.config.attribute_name, &attribute_value);
        } else {
            node.attrs.push(self.create_jsx_attr(&self.config.attribute_name, &attribute_value));
        }
        
        // Add global repo and branch attributes if needed
        unsafe {
            if let Some(ref repo_name) = *GIT_REPO {
                if !GLOBAL_ATTRIBUTES_ADDED && self.is_suitable_element(&node.name) {
                    // Add repo attribute if not exists
                    if !self.has_attr(&node.attrs, &self.config.repo_attribute_name) {
                        eprintln!("✓ Adding repo attribute globally to element");
                        node.attrs.push(self.create_jsx_attr(&self.config.repo_attribute_name, repo_name));
                    }
                    
                    // Add branch attribute if not exists
                    if !self.has_attr(&node.attrs, &self.config.branch_attribute_name) {
                        eprintln!("✓ Adding branch attribute globally to element");
                        node.attrs.push(self.create_jsx_attr(&self.config.branch_attribute_name, &GIT_BRANCH));
                    }
                    
                    GLOBAL_ATTRIBUTES_ADDED = true;
                    eprintln!("ℹ Repo/branch attributes added globally. Won't add again.");
                }
            }
        }
        
        node
    }
}

/// Plugin entry point
#[plugin_transform]
pub fn process_transform(program: Program, _metadata: TransformPluginProgramMetadata) -> Program {
    let config = Config::default(); // In a real plugin, you'd parse config from metadata
    
    let filename = "unknown"; // We'll need to get this from metadata in a real implementation
    
    let mut transform = CodePressTransform::new(config, filename);
    program.fold_with(&mut transform)
}

pub fn add(left: u64, right: u64) -> u64 {
    left + right
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_works() {
        let result = add(2, 2);
        assert_eq!(result, 4);
    }
    
    #[test]
    fn test_encode_function() {
        let result = encode("test.jsx");
        assert!(!result.is_empty());
        assert!(result.len() > 0);
    }
    
    #[test]
    fn test_encode_empty_string() {
        let result = encode("");
        assert_eq!(result, "");
    }
    
    #[test]
    fn test_encode_consistent() {
        let path = "src/components/App.jsx";
        let result1 = encode(path);
        let result2 = encode(path);
        assert_eq!(result1, result2);
    }
    
    #[test]
    fn test_config_default() {
        let config = Config::default();
        assert_eq!(config.attribute_name, "codepress-data-fp");
        assert_eq!(config.repo_attribute_name, "codepress-github-repo-name");
        assert_eq!(config.branch_attribute_name, "codepress-github-branch");
    }
    
    #[test]
    fn test_config_custom() {
        let config = Config {
            attribute_name: "custom-fp".to_string(),
            repo_attribute_name: "custom-repo".to_string(),
            branch_attribute_name: "custom-branch".to_string(),
        };
        
        assert_eq!(config.attribute_name, "custom-fp");
        assert_eq!(config.repo_attribute_name, "custom-repo");
        assert_eq!(config.branch_attribute_name, "custom-branch");
    }
    
    #[test]
    fn test_transform_creation() {
        let config = Config::default();
        let transform = CodePressTransform::new(config.clone(), "test.jsx");
        
        assert_eq!(transform.config.attribute_name, config.attribute_name);
        assert!(!transform.encoded_path.is_empty());
    }
    
    #[test]
    fn test_transform_skips_node_modules() {
        let config = Config::default();
        let transform = CodePressTransform::new(config, "node_modules/react/index.js");
        
        assert_eq!(transform.encoded_path, "");
    }
    
    #[test]
    fn test_transform_skips_empty_path() {
        let config = Config::default();
        let transform = CodePressTransform::new(config, "");
        
        assert_eq!(transform.encoded_path, "");
    }
    
    #[test]
    fn test_jsx_attr_creation() {
        let config = Config::default();
        let transform = CodePressTransform::new(config, "test.jsx");
        
        let attr = transform.create_jsx_attr("test-attr", "test-value");
        
        match attr {
            JSXAttrOrSpread::JSXAttr(jsx_attr) => {
                match jsx_attr.name {
                    JSXAttrName::Ident(ident) => {
                        assert_eq!(ident.sym.as_ref(), "test-attr");
                    }
                    _ => panic!("Expected ident name"),
                }
                
                match jsx_attr.value {
                    Some(JSXAttrValue::Lit(Lit::Str(str_lit))) => {
                        assert_eq!(str_lit.value.as_ref(), "test-value");
                    }
                    _ => panic!("Expected string literal value"),
                }
            }
            _ => panic!("Expected JSX attribute"),
        }
    }
    
    #[test] 
    fn test_suitable_element_detection() {
        let config = Config::default();
        let transform = CodePressTransform::new(config, "test.jsx");
        
        // Create test JSX element names (using Ident instead of IdentName for JSXElementName)
        let div_name = JSXElementName::Ident(Ident::new(Atom::from("div"), DUMMY_SP, SyntaxContext::empty()));
        let html_name = JSXElementName::Ident(Ident::new(Atom::from("html"), DUMMY_SP, SyntaxContext::empty()));
        let body_name = JSXElementName::Ident(Ident::new(Atom::from("body"), DUMMY_SP, SyntaxContext::empty()));
        let span_name = JSXElementName::Ident(Ident::new(Atom::from("span"), DUMMY_SP, SyntaxContext::empty()));
        
        assert!(transform.is_suitable_element(&div_name));
        assert!(transform.is_suitable_element(&html_name));
        assert!(transform.is_suitable_element(&body_name));
        assert!(!transform.is_suitable_element(&span_name));
    }
} 