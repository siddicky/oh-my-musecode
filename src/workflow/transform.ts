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
    body = asNodes(Parser.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));
  } catch {
    return `(async () => {\n${code}\n})()`;
  }

  const edits: Edit[] = [];
  for (const node of body) {
    if (node.type === 'ImportDeclaration' || node.type.startsWith('Export')) {
      edits.push({ start: node.start, end: node.end, text: '' });
      continue;
    }
    if (node.type === 'VariableDeclaration') {
      edits.push({ start: node.start, end: node.end, text: hoistDeclaration(code, node) });
      continue;
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      const id = node['id'] as AnyNode | null;
      if (id && id.type === 'Identifier' && typeof id['name'] === 'string') {
        edits.push({
          start: node.end,
          end: node.end,
          text: `\nglobalThis.${id['name']} = ${id['name']};`,
        });
      }
    }
  }

  const last = [...body].reverse().find((node) => {
    const slice = code.slice(node.start, node.end).trim();
    return slice !== '' && slice !== ';';
  });
  if (last && last.type === 'ExpressionStatement') {
    const expression = last['expression'] as AnyNode;
    edits.push({ start: last.start, end: last.start, text: 'return (' });
    edits.push({ start: expression.end, end: expression.end, text: ')' });
  }

  return `(async () => {\n${applyEdits(code, edits)}\n})()`;
}
