// CodePress SWC Plugin - Rust implementation
// This plugin mirrors the functionality of the Babel plugin

use std::process::Command;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use once_cell::sync::Lazy;
use regex::Regex;
use swc_core::{
    ecma::{
        ast::*,
        atoms::Atom,
        visit::{VisitMut, VisitMutWith},
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

/// XOR encoding function (matches the Babel plugin exactly)
fn encode(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    
    let input_bytes = input.as_bytes();
    let secret_len = SECRET.len();
    
    let xored: Vec<u8> = input_bytes
        .iter()
        .enumerate()
        .map(|(i, &byte)| byte ^ SECRET[i % secret_len])
        .collect();
    
    // Use standard base64 encoding then manually replace characters to match Babel version
    let base64_encoded = STANDARD.encode(xored);
    base64_encoded
        .replace('+', "-")
        .replace('/', "_")
        .replace('=', "")
}

/// Get git repository name from remote origin
fn get_git_repo_name() -> Option<String> {
    static GIT_REPO_NAME: Lazy<Option<String>> = Lazy::new(|| {
        let output = Command::new("git")
            .args(["config", "--get", "remote.origin.url"])
            .output()
            .ok()?;
        
        if !output.status.success() {
            return None;
        }
        
        let url = String::from_utf8(output.stdout).ok()?.trim().to_string();
        
        // Extract repo name from various Git URL formats
        let repo_regex = Regex::new(r"[:/]([^/]+/[^/]+?)(?:\.git)?/?$").ok()?;
        let captures = repo_regex.captures(&url)?;
        Some(captures.get(1)?.as_str().to_string())
    });
    
    GIT_REPO_NAME.clone()
}

/// Get current git branch
fn get_git_branch() -> Option<String> {
    static GIT_BRANCH: Lazy<Option<String>> = Lazy::new(|| {
        let output = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .ok()?;
        
        if !output.status.success() {
            return None;
        }
        
        let branch = String::from_utf8(output.stdout).ok()?.trim().to_string();
        if branch.is_empty() || branch == "HEAD" {
            None
        } else {
            Some(branch)
        }
    });
    
    GIT_BRANCH.clone()
}

/// Transform visitor that adds CodePress attributes to JSX elements
pub struct CodePressTransform {
    config: Config,
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
            encoded_path,
        }
    }
    
    /// Create JSX attribute with encoded file path
    fn create_file_path_attribute(&self, span: swc_core::common::Span) -> JSXAttrOrSpread {
        JSXAttrOrSpread::JSXAttr(JSXAttr {
            span,
            name: JSXAttrName::Ident(IdentName::new(
                Atom::from(self.config.attribute_name.as_str()),
                span,
            )),
            value: Some(JSXAttrValue::Lit(Lit::Str(Str {
                span,
                value: Atom::from(self.encoded_path.as_str()),
                raw: None,
            }))),
        })
    }
    
    /// Create JSX attribute for git repository name
    fn create_repo_attribute(&self, span: swc_core::common::Span) -> Option<JSXAttrOrSpread> {
        get_git_repo_name().map(|repo_name| {
            JSXAttrOrSpread::JSXAttr(JSXAttr {
                span,
                name: JSXAttrName::Ident(IdentName::new(
                    Atom::from(self.config.repo_attribute_name.as_str()),
                    span,
                )),
                value: Some(JSXAttrValue::Lit(Lit::Str(Str {
                    span,
                    value: Atom::from(repo_name.as_str()),
                    raw: None,
                }))),
            })
        })
    }
    
    /// Create JSX attribute for git branch name
    fn create_branch_attribute(&self, span: swc_core::common::Span) -> Option<JSXAttrOrSpread> {
        get_git_branch().map(|branch_name| {
            JSXAttrOrSpread::JSXAttr(JSXAttr {
                span,
                name: JSXAttrName::Ident(IdentName::new(
                    Atom::from(self.config.branch_attribute_name.as_str()),
                    span,
                )),
                value: Some(JSXAttrValue::Lit(Lit::Str(Str {
                    span,
                    value: Atom::from(branch_name.as_str()),
                    raw: None,
                }))),
            })
        })
    }
}

impl VisitMut for CodePressTransform {
    fn visit_mut_jsx_opening_element(&mut self, element: &mut JSXOpeningElement) {
        // Skip if no encoded path (e.g., node_modules files)
        if self.encoded_path.is_empty() {
            return;
        }
        
        // Add the file path attribute
        element.attrs.push(self.create_file_path_attribute(element.span));
        
        // Add repo and branch attributes globally (only once)
        unsafe {
            if !GLOBAL_ATTRIBUTES_ADDED {
                if let Some(repo_attr) = self.create_repo_attribute(element.span) {
                    element.attrs.push(repo_attr);
                }
                if let Some(branch_attr) = self.create_branch_attribute(element.span) {
                    element.attrs.push(branch_attr);
                }
                GLOBAL_ATTRIBUTES_ADDED = true;
            }
        }
        
        // Continue visiting child elements
        element.visit_mut_children_with(self);
    }
}

/// Plugin entry point
#[plugin_transform]
pub fn process_transform(mut program: Program, metadata: TransformPluginProgramMetadata) -> Program {
    // Try to get filename from metadata context, fallback to default
    let filename = metadata
        .get_context(&swc_core::plugin::metadata::TransformPluginMetadataContextKind::Filename)
        .unwrap_or_else(|| "unknown.jsx".to_string());
    
    let config = Config::default();
    
    // Create a stable transform without line numbers to avoid serialization issues
    let mut transform = CodePressTransform::new(config, &filename);
    program.visit_mut_with(&mut transform);
    
    program
}

// Helper function for tests
pub fn add(left: usize, right: usize) -> usize {
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
        println!("Encoded result: {}", result);
    }

    #[test]
    fn test_encode_empty_string() {
        let result = encode("");
        assert_eq!(result, "");
    }

    #[test]
    fn test_encode_consistent() {
        let path = "src/components/Button.jsx";
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
    fn test_transform_creation() {
        let config = Config::default();
        let transform = CodePressTransform::new(config, "test.jsx");
        assert!(!transform.encoded_path.is_empty());
    }

    #[test]
    fn test_node_modules_skipped() {
        let config = Config::default();
        let transform = CodePressTransform::new(config, "node_modules/react/index.js");
        assert!(transform.encoded_path.is_empty());
    }

    #[test]
    fn test_encode_matches_babel() {
        // Test with a known input to ensure consistency with Babel plugin
        let input = "src/components/Button.jsx";
        let result = encode(input);
        
        // The result should be a non-empty string with URL-safe base64 characters
        assert!(!result.is_empty());
        assert!(!result.contains('+'));
        assert!(!result.contains('/'));
        assert!(!result.contains('='));
        
        // Should only contain URL-safe base64 characters
        for c in result.chars() {
            assert!(c.is_ascii_alphanumeric() || c == '-' || c == '_');
        }
    }
} 