/**
 * Provenance Tracking for Babel Plugin
 * Ported from SWC plugin (lib.rs lines 1203-1283, 553-904)
 */

import type * as Babel from "@babel/core";

export type ProvNode =
  | { kind: 'Literal'; span: string; value_kind: 'string' | 'number' | 'other' }
  | { kind: 'Ident'; name: string; span: string }
  | { kind: 'Init'; span: string }
  | { kind: 'Import'; source: string; imported: string; span: string }
  | { kind: 'Member'; span: string }
  | { kind: 'ObjectProp'; key: string; span: string }
  | { kind: 'ArrayElem'; index: number; span: string }
  | { kind: 'Call'; callee: string; callsite: string; callee_span: string; fn_def_span?: string }
  | { kind: 'Ctor'; callee: string; span: string }
  | { kind: 'Op'; op: string; span: string }
  | { kind: 'Env'; key: string; span: string }
  | { kind: 'Unknown'; span: string };

export interface Candidate {
  target: string;
  reason: string;
}

export interface SymbolRef {
  file: string;
  local: string;
  path: string;
  span: string;
}

interface Binding {
  defSpan: string;
  init?: Babel.types.Expression;
  import?: { source: string; imported: string };
  fnBodySpan?: string;
}

export class ProvenanceTracker {
  private bindings: Map<string, Binding> = new Map();
  private filename: string;

  constructor(filename: string) {
    this.filename = filename;
  }

  // Port of collect_bindings (lib.rs:555-560)
  collectBindings(program: Babel.NodePath<Babel.types.Program>) {
    program.traverse({
      VariableDeclarator: (path) => {
        if (path.node.id.type === 'Identifier') {
          this.bindings.set(path.node.id.name, {
            defSpan: this.makeSpan(path.node.id.loc),
            init: path.node.init ?? undefined,
          });
        }
      },
      FunctionDeclaration: (path) => {
        if (path.node.id) {
          this.bindings.set(path.node.id.name, {
            defSpan: this.makeSpan(path.node.id.loc),
            fnBodySpan: this.makeSpan(path.node.body.loc),
          });
        }
      },
      ImportDeclaration: (path) => {
        for (const spec of path.node.specifiers) {
          let imported: string;
          if (spec.type === 'ImportSpecifier') {
            imported = spec.imported.type === 'Identifier'
              ? spec.imported.name
              : spec.local.name;
          } else if (spec.type === 'ImportDefaultSpecifier') {
            imported = 'default';
          } else {
            imported = '*';
          }

          this.bindings.set(spec.local.name, {
            defSpan: this.makeSpan(spec.local.loc),
            import: {
              source: path.node.source.value,
              imported,
            },
          });
        }
      },
    });
  }

  // Port of trace_expr (lib.rs:562-765)
  traceExpression(
    expr: Babel.types.Expression,
    chain: ProvNode[],
    depth: number = 0,
    seen: Set<string> = new Set()
  ): void {
    if (depth > 8 || chain.length > 128) return;

    switch (expr.type) {
      case 'NumericLiteral':
        chain.push({
          kind: 'Literal',
          span: this.makeSpan(expr.loc),
          value_kind: 'number',
        });
        break;

      case 'StringLiteral':
        chain.push({
          kind: 'Literal',
          span: this.makeSpan(expr.loc),
          value_kind: 'string',
        });
        break;

      case 'BooleanLiteral':
      case 'NullLiteral':
        chain.push({
          kind: 'Literal',
          span: this.makeSpan(expr.loc),
          value_kind: 'other',
        });
        break;

      case 'Identifier':
        chain.push({
          kind: 'Ident',
          name: expr.name,
          span: this.makeSpan(expr.loc),
        });

        if (seen.has(expr.name)) return;
        seen.add(expr.name);

        const binding = this.bindings.get(expr.name);
        if (binding) {
          if (binding.init) {
            chain.push({ kind: 'Init', span: this.makeSpan(binding.init.loc) });
            this.traceExpression(binding.init, chain, depth + 1, seen);
          }
          if (binding.import) {
            chain.push({
              kind: 'Import',
              source: binding.import.source,
              imported: binding.import.imported,
              span: binding.defSpan,
            });
          }
        }
        break;

      case 'MemberExpression':
        const envKey = this.detectEnvMember(expr);
        if (envKey) {
          chain.push({
            kind: 'Env',
            key: envKey,
            span: this.makeSpan(expr.loc),
          });
          return;
        }

        chain.push({ kind: 'Member', span: this.makeSpan(expr.loc) });
        this.traceExpression(expr.object as Babel.types.Expression, chain, depth + 1, seen);
        if (expr.computed && expr.property.type !== 'PrivateName') {
          this.traceExpression(expr.property as Babel.types.Expression, chain, depth + 1, seen);
        }
        break;

      case 'CallExpression':
        let calleeName = '<expr>';
        let calleeSpan = this.makeSpan(expr.loc);
        let fnDefSpan: string | undefined;

        if (expr.callee.type === 'Identifier') {
          calleeName = expr.callee.name;
          calleeSpan = this.makeSpan(expr.callee.loc);
          const binding = this.bindings.get(expr.callee.name);
          fnDefSpan = binding?.fnBodySpan || binding?.defSpan;
        } else if (expr.callee.type === 'MemberExpression') {
          calleeName = '<member>';
          calleeSpan = this.makeSpan(expr.callee.loc);
        }

        chain.push({
          kind: 'Call',
          callee: calleeName,
          callsite: this.makeSpan(expr.loc),
          callee_span: calleeSpan,
          fn_def_span: fnDefSpan,
        });

        for (const arg of expr.arguments) {
          if (arg.type !== 'SpreadElement' && arg.type !== 'ArgumentPlaceholder') {
            this.traceExpression(arg, chain, depth + 1, seen);
          }
        }
        break;

      case 'NewExpression':
        const ctorName = expr.callee.type === 'Identifier'
          ? expr.callee.name
          : '<expr>';
        chain.push({
          kind: 'Ctor',
          callee: ctorName,
          span: this.makeSpan(expr.loc),
        });
        if (expr.arguments) {
          for (const arg of expr.arguments) {
            if (arg.type !== 'SpreadElement' && arg.type !== 'ArgumentPlaceholder') {
              this.traceExpression(arg, chain, depth + 1, seen);
            }
          }
        }
        break;

      case 'TemplateLiteral':
        chain.push({
          kind: 'Op',
          op: 'template',
          span: this.makeSpan(expr.loc),
        });
        for (const elem of expr.expressions) {
          this.traceExpression(elem as Babel.types.Expression, chain, depth + 1, seen);
        }
        break;

      case 'BinaryExpression':
        chain.push({
          kind: 'Op',
          op: `binary:${expr.operator}`,
          span: this.makeSpan(expr.loc),
        });
        this.traceExpression(expr.left as Babel.types.Expression, chain, depth + 1, seen);
        this.traceExpression(expr.right, chain, depth + 1, seen);
        break;

      case 'ConditionalExpression':
        chain.push({
          kind: 'Op',
          op: 'cond',
          span: this.makeSpan(expr.loc),
        });
        this.traceExpression(expr.test, chain, depth + 1, seen);
        this.traceExpression(expr.consequent, chain, depth + 1, seen);
        this.traceExpression(expr.alternate, chain, depth + 1, seen);
        break;

      case 'UnaryExpression':
        chain.push({
          kind: 'Op',
          op: `unary:${expr.operator}`,
          span: this.makeSpan(expr.loc),
        });
        this.traceExpression(expr.argument, chain, depth + 1, seen);
        break;

      case 'UpdateExpression':
        chain.push({
          kind: 'Op',
          op: 'update',
          span: this.makeSpan(expr.loc),
        });
        this.traceExpression(expr.argument, chain, depth + 1, seen);
        break;

      case 'ObjectExpression':
        for (const prop of expr.properties) {
          if (prop.type === 'ObjectProperty') {
            let key: string;
            if (prop.key.type === 'Identifier') {
              key = prop.key.name;
            } else if (prop.key.type === 'StringLiteral') {
              key = prop.key.value;
            } else {
              key = '<computed>';
            }

            chain.push({
              kind: 'ObjectProp',
              key,
              span: this.makeSpan(prop.key.loc),
            });

            this.traceExpression(prop.value as Babel.types.Expression, chain, depth + 1, seen);
          }
        }
        break;

      case 'ArrayExpression':
        expr.elements.forEach((el, idx) => {
          if (el && el.type !== 'SpreadElement') {
            chain.push({
              kind: 'ArrayElem',
              index: idx,
              span: this.makeSpan(el.loc),
            });
            this.traceExpression(el as Babel.types.Expression, chain, depth + 1, seen);
          }
        });
        break;

      default:
        chain.push({
          kind: 'Unknown',
          span: this.makeSpan(expr.loc),
        });
    }
  }

  // Port of rank_candidates (lib.rs:767-829)
  rankCandidates(chain: ProvNode[]): Candidate[] {
    const candidates: Candidate[] = [];
    const seen = new Set<string>();

    for (const node of chain) {
      switch (node.kind) {
        case 'Literal':
          candidates.push({ target: node.span, reason: 'literal' });
          break;
        case 'Init':
          candidates.push({ target: node.span, reason: 'const-init' });
          break;
        case 'Member':
          candidates.push({ target: node.span, reason: 'member' });
          break;
        case 'ObjectProp':
        case 'ArrayElem':
          candidates.push({ target: node.span, reason: 'structural' });
          break;
        case 'Call':
          candidates.push({ target: node.callsite, reason: 'callsite' });
          if (node.fn_def_span) {
            candidates.push({ target: node.fn_def_span, reason: 'fn-def' });
          }
          break;
        case 'Ctor':
          candidates.push({ target: node.span, reason: 'constructor' });
          break;
        case 'Import':
          candidates.push({ target: node.span, reason: 'import' });
          break;
        case 'Env':
          candidates.push({ target: node.span, reason: 'env' });
          break;
      }
    }

    // Dedup
    return candidates.filter(c => {
      const key = `${c.reason}#${c.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Port of aggregate_kinds (lib.rs:881-904)
  aggregateKinds(chain: ProvNode[]): string[] {
    const kinds = new Set<string>();
    for (const node of chain) {
      switch (node.kind) {
        case 'Literal': kinds.add('literal'); break;
        case 'Ident': kinds.add('ident'); break;
        case 'Init': kinds.add('init'); break;
        case 'Import': kinds.add('import'); break;
        case 'Member': kinds.add('member'); break;
        case 'ObjectProp': kinds.add('object'); break;
        case 'ArrayElem': kinds.add('array'); break;
        case 'Call': kinds.add('call'); break;
        case 'Ctor': kinds.add('ctor'); break;
        case 'Op': kinds.add('op'); break;
        case 'Env': kinds.add('env'); break;
        case 'Unknown': kinds.add('unknown'); break;
      }
    }
    return Array.from(kinds).sort();
  }

  // Port of collect_symbol_refs_from_expr (lib.rs:830-879)
  collectSymbolRefs(expr: Babel.types.Expression, refs: SymbolRef[]): void {
    if (expr.type === 'Identifier') {
      refs.push({
        file: this.filename,
        local: expr.name,
        path: '',
        span: this.makeSpan(expr.loc),
      });

      // Chase initializer
      const binding = this.bindings.get(expr.name);
      if (binding?.init) {
        this.collectSymbolRefs(binding.init, refs);
      }
    } else if (expr.type === 'MemberExpression') {
      const memberPath = this.staticMemberPath(expr);
      if (memberPath) {
        refs.push({
          file: this.filename,
          local: memberPath.root,
          path: memberPath.path,
          span: this.makeSpan(expr.loc),
        });
      }

      // Descend
      this.collectSymbolRefs(expr.object as Babel.types.Expression, refs);
      if (expr.computed && expr.property.type !== 'PrivateName') {
        this.collectSymbolRefs(expr.property as Babel.types.Expression, refs);
      }
    } else if (expr.type === 'CallExpression') {
      if (expr.callee.type !== 'Super' && expr.callee.type !== 'V8IntrinsicIdentifier') {
        this.collectSymbolRefs(expr.callee, refs);
      }
      for (const arg of expr.arguments) {
        if (arg.type !== 'SpreadElement' && arg.type !== 'ArgumentPlaceholder') {
          this.collectSymbolRefs(arg, refs);
        }
      }
    }
  }

  // Port of detect_env_member (lib.rs:1388-1413)
  private detectEnvMember(expr: Babel.types.MemberExpression): string | null {
    // process.env.X
    if (
      expr.object.type === 'MemberExpression' &&
      expr.object.object.type === 'Identifier' &&
      expr.object.object.name === 'process' &&
      expr.object.property.type === 'Identifier' &&
      expr.object.property.name === 'env' &&
      expr.property.type === 'Identifier'
    ) {
      return expr.property.name;
    }

    // import.meta.env.X
    if (
      expr.object.type === 'MemberExpression' &&
      expr.object.object.type === 'MetaProperty' &&
      expr.object.object.meta.name === 'import' &&
      expr.object.object.property.name === 'meta' &&
      expr.object.property.type === 'Identifier' &&
      expr.object.property.name === 'env' &&
      expr.property.type === 'Identifier'
    ) {
      return expr.property.name;
    }

    return null;
  }

  private staticMemberPath(expr: Babel.types.MemberExpression): { root: string; path: string } | null {
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
          return null;
        }
      }
      current = current.object;
    }

    if (current.type === 'Identifier') {
      return { root: current.name, path: parts.join('') };
    }

    return null;
  }

  private makeSpan(loc: Babel.types.SourceLocation | null | undefined): string {
    if (!loc) return `${this.filename}:0`;
    return `${this.filename}:${loc.start.line}`;
  }
}
