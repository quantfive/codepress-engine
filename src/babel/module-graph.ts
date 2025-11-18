/**
 * Module Graph Collection for Babel Plugin
 * Ported from SWC plugin (lib.rs lines 1143-1200)
 */

import type * as Babel from "@babel/core";

export interface ImportRow {
  local: string;    // local alias in this module
  imported: string; // 'default' | named | '*' (namespace)
  source: string;   // "../module"
  span: string;     // "file:line"
}

export interface ExportRow {
  exported: string; // name visible to other modules
  local: string;    // local symbol bound in this module
  span: string;
}

export interface ReexportRow {
  exported: string;
  imported: string;
  source: string;
  span: string;
}

export interface DefRow {
  local: string;
  kind: 'var' | 'let' | 'const' | 'func' | 'class';
  span: string;
}

export interface MutationRow {
  root: string;       // root local ident being mutated
  path: string;       // dotted/index path: ".new_key" or "[0]"
  kind: 'assign' | 'update' | 'call:Object.assign' | 'call:push' | 'call:set';
  span: string;
}

export interface LiteralIxRow {
  export_name: string;
  path: string;
  text: string;
  span: string;
}

export interface ModuleGraph {
  imports: ImportRow[];
  exports: ExportRow[];
  reexports: ReexportRow[];
  defs: DefRow[];
  mutations: MutationRow[];
  literal_index: LiteralIxRow[];
}

export class ModuleGraphCollector {
  public graph: ModuleGraph;
  private filename: string;

  constructor(filename: string) {
    this.filename = filename;
    this.graph = {
      imports: [],
      exports: [],
      reexports: [],
      defs: [],
      mutations: [],
      literal_index: [],
    };
  }

  // Port of visit_mut_import_decl (lib.rs:1549-1589)
  visitImportDeclaration(path: Babel.NodePath<Babel.types.ImportDeclaration>) {
    const source = path.node.source.value;

    for (const spec of path.node.specifiers) {
      if (spec.type === 'ImportSpecifier') {
        this.graph.imports.push({
          local: spec.local.name,
          imported: spec.imported.type === 'Identifier'
            ? spec.imported.name
            : spec.local.name,
          source,
          span: this.makeSpan(spec.loc),
        });
      } else if (spec.type === 'ImportDefaultSpecifier') {
        this.graph.imports.push({
          local: spec.local.name,
          imported: 'default',
          source,
          span: this.makeSpan(spec.loc),
        });
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        this.graph.imports.push({
          local: spec.local.name,
          imported: '*',
          source,
          span: this.makeSpan(spec.loc),
        });
      }
    }
  }

  // Port of visit_mut_export_decl (lib.rs:1592-1658)
  visitExportNamedDeclaration(path: Babel.NodePath<Babel.types.ExportNamedDeclaration>) {
    const { declaration, specifiers, source } = path.node;

    if (source) {
      // export { x } from './module' - Reexport
      for (const spec of specifiers) {
        if (spec.type === 'ExportSpecifier') {
          this.graph.reexports.push({
            exported: spec.exported.type === 'Identifier'
              ? spec.exported.name
              : (spec.exported as any).value,
            imported: spec.local.type === 'Identifier'
              ? spec.local.name
              : (spec.local as any).value,
            source: source.value,
            span: this.makeSpan(spec.loc),
          });
        }
      }
    } else if (declaration) {
      // export const x = ...
      if (declaration.type === 'VariableDeclaration') {
        for (const declarator of declaration.declarations) {
          if (declarator.id.type === 'Identifier') {
            const name = declarator.id.name;

            // Track definition
            this.graph.defs.push({
              local: name,
              kind: declaration.kind as 'var' | 'let' | 'const',
              span: this.makeSpan(declarator.loc),
            });

            // Track export
            this.graph.exports.push({
              exported: name,
              local: name,
              span: this.makeSpan(declarator.id.loc),
            });

            // Harvest literals from initializer
            if (declarator.init) {
              this.harvestLiteralIndex(name, declarator.init, '');
            }
          }
        }
      } else if (declaration.type === 'FunctionDeclaration' && declaration.id) {
        const name = declaration.id.name;
        this.graph.defs.push({
          local: name,
          kind: 'func',
          span: this.makeSpan(declaration.id.loc),
        });
        this.graph.exports.push({
          exported: name,
          local: name,
          span: this.makeSpan(declaration.id.loc),
        });
      } else if (declaration.type === 'ClassDeclaration' && declaration.id) {
        const name = declaration.id.name;
        this.graph.defs.push({
          local: name,
          kind: 'class',
          span: this.makeSpan(declaration.id.loc),
        });
        this.graph.exports.push({
          exported: name,
          local: name,
          span: this.makeSpan(declaration.id.loc),
        });
      }
    } else {
      // export { x } (no source)
      for (const spec of specifiers) {
        if (spec.type === 'ExportSpecifier' && spec.local.type === 'Identifier') {
          this.graph.exports.push({
            exported: spec.exported.type === 'Identifier'
              ? spec.exported.name
              : (spec.exported as any).value,
            local: spec.local.name,
            span: this.makeSpan(spec.local.loc),
          });
        }
      }
    }
  }

  // Port of visit_mut_var_declarator (lib.rs:1740-1753)
  visitVariableDeclarator(
    path: Babel.NodePath<Babel.types.VariableDeclarator>,
    kind: 'var' | 'let' | 'const'
  ) {
    if (path.node.id.type === 'Identifier') {
      this.graph.defs.push({
        local: path.node.id.name,
        kind,
        span: this.makeSpan(path.node.loc),
      });
    }
  }

  // Port of visit_mut_assign_expr (lib.rs:1773-1814)
  visitAssignmentExpression(path: Babel.NodePath<Babel.types.AssignmentExpression>) {
    const { left } = path.node;

    if (left.type === 'Identifier') {
      this.graph.mutations.push({
        root: left.name,
        path: '',
        kind: 'assign',
        span: this.makeSpan(path.node.loc),
      });
    } else if (left.type === 'MemberExpression') {
      const memberPath = this.staticMemberPath(left);
      if (memberPath) {
        this.graph.mutations.push({
          root: memberPath.root,
          path: memberPath.path,
          kind: 'assign',
          span: this.makeSpan(path.node.loc),
        });
      }
    }
  }

  // Port of visit_mut_update_expr (lib.rs:1816-1830)
  visitUpdateExpression(path: Babel.NodePath<Babel.types.UpdateExpression>) {
    const { argument } = path.node;

    if (argument.type === 'Identifier') {
      this.graph.mutations.push({
        root: argument.name,
        path: '',
        kind: 'update',
        span: this.makeSpan(path.node.loc),
      });
    } else if (argument.type === 'MemberExpression') {
      const memberPath = this.staticMemberPath(argument);
      if (memberPath) {
        this.graph.mutations.push({
          root: memberPath.root,
          path: memberPath.path,
          kind: 'update',
          span: this.makeSpan(path.node.loc),
        });
      }
    }
  }

  // Port of visit_mut_call_expr (lib.rs:1832-1859)
  visitCallExpression(path: Babel.NodePath<Babel.types.CallExpression>) {
    const { callee, arguments: args } = path.node;

    // Object.assign(target, ...)
    if (
      callee.type === 'MemberExpression' &&
      callee.object.type === 'Identifier' &&
      callee.object.name === 'Object' &&
      callee.property.type === 'Identifier' &&
      callee.property.name === 'assign'
    ) {
      const firstArg = args[0];
      if (firstArg?.type === 'Identifier') {
        this.graph.mutations.push({
          root: firstArg.name,
          path: '',
          kind: 'call:Object.assign',
          span: this.makeSpan(path.node.loc),
        });
      } else if (firstArg?.type === 'MemberExpression') {
        const memberPath = this.staticMemberPath(firstArg);
        if (memberPath) {
          this.graph.mutations.push({
            root: memberPath.root,
            path: memberPath.path,
            kind: 'call:Object.assign',
            span: this.makeSpan(path.node.loc),
          });
        }
      }
    }
    // array.push(), map.set(), etc.
    else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
      const method = callee.property.name;
      const memberPath = this.staticMemberPath(callee.object);

      if (memberPath) {
        let kind: MutationRow['kind'] = 'assign';
        if (['push', 'unshift', 'splice'].includes(method)) {
          kind = 'call:push';
        } else if (['set', 'setIn'].includes(method)) {
          kind = 'call:set';
        }

        this.graph.mutations.push({
          root: memberPath.root,
          path: memberPath.path,
          kind,
          span: this.makeSpan(path.node.loc),
        });
      }
    }
  }

  // Port of static_member_path (lib.rs:348-397)
  private staticMemberPath(expr: Babel.types.Expression):
    { root: string; path: string } | null {

    if (expr.type === 'Identifier') {
      return { root: expr.name, path: '' };
    }

    if (expr.type !== 'MemberExpression') {
      return null;
    }

    const parts: string[] = [];
    let current: any = expr;

    while (current.type === 'MemberExpression') {
      if (current.property.type === 'Identifier' && !current.computed) {
        parts.unshift(`.${current.property.name}`);
      } else if (current.computed) {
        if (current.property.type === 'StringLiteral') {
          parts.unshift(`["${current.property.value}"]`);
        } else if (current.property.type === 'NumericLiteral') {
          parts.unshift(`[${current.property.value}]`);
        } else {
          return null; // Non-static computed property
        }
      }
      current = current.object;
    }

    if (current.type === 'Identifier') {
      return { root: current.name, path: parts.join('') };
    }

    return null;
  }

  // Port of harvest_literal_index (lib.rs:2264-2310)
  private harvestLiteralIndex(
    exportName: string,
    node: Babel.types.Node,
    prefix: string
  ) {
    if (node.type === 'ObjectExpression') {
      for (const prop of node.properties) {
        if (prop.type === 'ObjectProperty') {
          let key: string;
          if (prop.key.type === 'Identifier') {
            key = prop.key.name;
          } else if (prop.key.type === 'StringLiteral') {
            key = prop.key.value;
          } else if (prop.key.type === 'NumericLiteral') {
            key = String(prop.key.value);
          } else {
            continue;
          }

          const path = prefix ? `${prefix}.${key}` : key;
          this.harvestLiteralIndex(exportName, prop.value, path);
        }
      }
    } else if (node.type === 'ArrayExpression') {
      node.elements.forEach((el, idx) => {
        if (el && el.type !== 'SpreadElement') {
          const path = `${prefix}[${idx}]`;
          this.harvestLiteralIndex(exportName, el, path);
        }
      });
    } else if (node.type === 'StringLiteral') {
      this.graph.literal_index.push({
        export_name: exportName,
        path: prefix,
        text: node.value,
        span: this.makeSpan(node.loc),
      });
    }
  }

  private makeSpan(loc: Babel.types.SourceLocation | null | undefined): string {
    if (!loc) return `${this.filename}:0`;
    return `${this.filename}:${loc.start.line}`;
  }

  getGraph(): ModuleGraph {
    return this.graph;
  }
}
