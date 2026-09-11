/**
 * REPL transform for interpreter input.
 *
 * QuickJS parses script-mode `await` as an identifier, so agent code with
 * top-level await needs an async wrapper. This transform parses the code as
 * a module, hoists top-level declarations onto `globalThis` so they persist
 * across eval calls, auto-returns a trailing expression statement, and wraps
 * everything in an async IIFE. Unparseable input falls back to a plain async
 * wrapper so the sandbox still reports the real error.
 */

import { Parser } from 'acorn';

interface AnyNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function asNode(value: unknown): AnyNode | null {
  if (typeof value !== 'object' || value === null) return null;
  const node = value as AnyNode;
  return typeof node.type === 'string' ? node : null;
}

function asNodes(value: unknown): AnyNode[] {
  if (typeof value !== 'object' || value === null) return [];
  const body = (value as { body?: unknown }).body;
  if (!Array.isArray(body)) return [];
  return body.filter(
    (entry): entry is AnyNode =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as AnyNode).type === 'string' &&
      typeof (entry as AnyNode).start === 'number' &&
      typeof (entry as AnyNode).end === 'number',
  );
}

function bindingNames(pattern: AnyNode): string[] {
  if (pattern.type === 'Identifier' && typeof pattern['name'] === 'string') {
    return [pattern['name']];
  }
  if (pattern.type === 'ObjectPattern') {
    const properties = pattern['properties'];
    if (!Array.isArray(properties)) return [];
    return properties.flatMap((prop) => {
      if (typeof prop !== 'object' || prop === null) return [];
      const entry = prop as AnyNode;
      if (entry.type === 'RestElement') return bindingNames(entry['argument'] as AnyNode);
      return bindingNames(entry['value'] as AnyNode);
    });
  }
  if (pattern.type === 'ArrayPattern') {
    const elements = pattern['elements'];
    if (!Array.isArray(elements)) return [];
    return elements.flatMap((el) =>
      typeof el === 'object' && el !== null ? bindingNames(el as AnyNode) : [],
    );
  }
  if (pattern.type === 'RestElement') return bindingNames(pattern['argument'] as AnyNode);
  if (pattern.type === 'AssignmentPattern') return bindingNames(pattern['left'] as AnyNode);
  return [];
}

// Known limitation: rebinding onto globalThis drops TDZ semantics, so
// `let x = x` reads a stale global instead of throwing. Cross-eval
// persistence needs global bindings; script-mode `var` keeps neither.
function hoistDeclaration(code: string, decl: AnyNode): string {
  const declarations = decl['declarations'];
  if (!Array.isArray(declarations)) return '';
  const parts: string[] = [];
  for (const entry of declarations) {
    if (typeof entry !== 'object' || entry === null) continue;
    const declarator = entry as AnyNode;
    const id = declarator['id'] as AnyNode;
    const init = declarator['init'] as AnyNode | null;
    const initCode = init ? code.slice(init.start, init.end) : 'undefined';
    if (id.type === 'Identifier' && typeof id['name'] === 'string') {
      parts.push(`globalThis.${id['name']} = ${initCode}`);
    } else if (id.type === 'ObjectPattern' || id.type === 'ArrayPattern') {
      parts.push(`var ${code.slice(id.start, id.end)} = ${initCode}`);
      for (const name of bindingNames(id)) {
        parts.push(`globalThis.${name} = ${name}`);
      }
    }
  }
  return parts.join('; ') + ';';
}

function applyEdits(code: string, edits: Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let output = code;
  for (const edit of ordered) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return output;
}

export function transformForEval(code: string): string {
  let body: AnyNode[];
  try {
    // Pinned below 'latest': newer syntax the sandbox cannot run (e.g.
    // `using` declarations) must fail here and take the plain-wrapper
    // fallback, not parse and silently miscompile.
    body = asNodes(Parser.parse(code, { ecmaVersion: 2025, sourceType: 'module' }));
  } catch {
    return `(async () => {\n${code}\n})()`;
  }

  const edits: Edit[] = [];
  // Fully blanked nodes, skipped when hunting the trailing value so a
  // stripped tail cannot mask an earlier expression.
  const stripped = new Set<AnyNode>();
  for (const node of body) {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') {
      edits.push({ start: node.start, end: node.end, text: '' });
      stripped.add(node);
      continue;
    }
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
      if (rewriteExport(code, node, edits)) stripped.add(node);
      continue;
    }
    if (node.type === 'VariableDeclaration') {
      edits.push({ start: node.start, end: node.end, text: hoistDeclaration(code, node) });
      continue;
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      hoistNamed(node, node, edits);
    }
  }

  const last = [...body].reverse().find((node) => {
    if (stripped.has(node)) return false;
    const slice = code.slice(node.start, node.end).trim();
    return slice !== '' && slice !== ';';
  });
  if (last && last.type === 'ExpressionStatement') {
    const expression = last['expression'] as AnyNode;
    edits.push({ start: last.start, end: last.start, text: 'return (' });
    edits.push({ start: expression.end, end: expression.end, text: ')' });
  } else if (last && last.type === 'ExportDefaultDeclaration') {
    // `export default <expr>;` evaluates like a trailing expression.
    const declaration = asNode(last['declaration']);
    if (
      declaration &&
      declaration.type !== 'FunctionDeclaration' &&
      declaration.type !== 'ClassDeclaration'
    ) {
      edits.push({ start: declaration.start, end: declaration.start, text: 'return (' });
      edits.push({ start: declaration.end, end: declaration.end, text: ')' });
    }
  }

  return `(async () => {\n${applyEdits(code, edits)}\n})()`;
}

/** Appends a `globalThis.<name> = <name>;` hoist for a named declaration. */
function hoistNamed(node: AnyNode, declaration: AnyNode, edits: Edit[]): void {
  const id = asNode(declaration['id']);
  if (id && id.type === 'Identifier' && typeof id['name'] === 'string') {
    edits.push({
      start: node.end,
      end: node.end,
      text: `\nglobalThis.${id['name']} = ${id['name']};`,
    });
  }
}

/**
 * Rewrites one export declaration into sandbox-runnable statements.
 * Declarations hoist like their plain counterparts; renamed specifiers alias
 * the new binding; re-exports from other modules are blanked. Returns whether
 * the node was fully blanked.
 */
function rewriteExport(code: string, node: AnyNode, edits: Edit[]): boolean {
  const declaration = asNode(node['declaration']);
  if (declaration) {
    if (declaration.type === 'VariableDeclaration') {
      edits.push({ start: node.start, end: node.end, text: hoistDeclaration(code, declaration) });
      return false;
    }
    if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
      const id = asNode(declaration['id']);
      const name =
        id?.type === 'Identifier' && typeof id['name'] === 'string' ? id['name'] : null;
      if (node.type === 'ExportDefaultDeclaration' && name === null) {
        // `export default function () {}`: bind the anonymous declaration.
        edits.push({ start: node.start, end: declaration.start, text: 'globalThis.default = ' });
      } else {
        // Strip the `export ...` prefix, keep the declaration, hoist the name.
        edits.push({ start: node.start, end: declaration.start, text: '' });
        hoistNamed(node, declaration, edits);
        if (node.type === 'ExportDefaultDeclaration' && name !== null) {
          edits.push({
            start: node.end,
            end: node.end,
            text: `\nglobalThis.default = ${name};`,
          });
        }
      }
      return false;
    }
    // `export default <expr>;`: strip the prefix, leave the expression for
    // the trailing-value rewrite.
    edits.push({ start: node.start, end: declaration.start, text: '' });
    return false;
  }
  if (node['source']) {
    // A re-export from another module cannot resolve; blank it.
    edits.push({ start: node.start, end: node.end, text: '' });
    return true;
  }
  // `export { a, b as c };`: same-name specifiers need nothing (their
  // declarations already hoisted), renamed ones alias the new binding.
  const specifiers = node['specifiers'];
  const parts: string[] = [];
  if (Array.isArray(specifiers)) {
    for (const entry of specifiers) {
      const specifier = asNode(entry);
      const local = specifier ? asNode(specifier['local']) : null;
      const exported = specifier ? asNode(specifier['exported']) : null;
      if (
        local?.type === 'Identifier' &&
        exported?.type === 'Identifier' &&
        typeof local['name'] === 'string' &&
        typeof exported['name'] === 'string' &&
        local['name'] !== exported['name']
      ) {
        parts.push(`globalThis.${exported['name']} = ${local['name']};`);
      }
    }
  }
  edits.push({ start: node.start, end: node.end, text: parts.join(' ') });
  return parts.length === 0;
}
