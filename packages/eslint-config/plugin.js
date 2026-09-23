// Local ESLint rules that keep the UI on design tokens and RTL-safe utilities.

/** Tailwind utilities tied to a physical side. Use logical ones (ms/me/ps/pe/start/end/…) instead. */
const PHYSICAL_CLASS =
  /(?:^|[\s:!])-?(?:m[lr]|p[lr]|scroll-m[lr]|scroll-p[lr]|left|right|inset-[lr]|border-[lr]|rounded-[lr]|rounded-[tb][lr]|text-(?:left|right)|float-(?:left|right)|clear-(?:left|right)|space-x-reverse)(?:-|$|\s|\/|\[)/;

/** A hex colour, either as a whole string or inside a Tailwind arbitrary value like bg-[#fff]. */
const HEX_COLOR = /(?:^|\[|\s|:)#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?:$|\]|\s|;)/i;

const CLASS_HELPERS = new Set(['cn', 'clsx', 'cva', 'twMerge', 'twJoin', 'cx']);

function stringsIn(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') out.push({ node, value: node.value });
      break;
    case 'TemplateLiteral':
      for (const q of node.quasis) out.push({ node: q, value: q.value.cooked ?? q.value.raw });
      for (const e of node.expressions) stringsIn(e, out);
      break;
    case 'JSXExpressionContainer':
      stringsIn(node.expression, out);
      break;
    case 'ConditionalExpression':
      stringsIn(node.consequent, out);
      stringsIn(node.alternate, out);
      break;
    case 'LogicalExpression':
    case 'BinaryExpression':
      stringsIn(node.left, out);
      stringsIn(node.right, out);
      break;
    case 'ArrayExpression':
      for (const el of node.elements) stringsIn(el, out);
      break;
    case 'ObjectExpression':
      for (const p of node.properties) {
        if (p.type === 'Property') {
          // clsx({ 'ml-2': cond }) — the key is the class list
          if (p.key.type === 'Literal') stringsIn(p.key, out);
          stringsIn(p.value, out);
        }
      }
      break;
    case 'CallExpression':
      for (const a of node.arguments) stringsIn(a, out);
      break;
    default:
      break;
  }
  return out;
}

function isClassHelperCall(node) {
  return node.callee.type === 'Identifier' && CLASS_HELPERS.has(node.callee.name);
}

/** @type {import('eslint').Rule.RuleModule} */
const noPhysicalDirectionClasses = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow physical-direction Tailwind utilities (ml/mr/pl/pr/left/right/…); use logical ones for RTL.',
    },
    messages: {
      physical:
        'Physical-direction utility in "{{value}}". Use logical utilities (ms-/me-/ps-/pe-/start-/end-/border-s/border-e/rounded-s/rounded-e/text-start/text-end).',
    },
    schema: [],
  },
  create(context) {
    // className={cn('…')} is visited by both handlers; report each string node once.
    const reported = new WeakSet();
    const check = (strings) => {
      for (const { node, value } of strings) {
        if (reported.has(node)) continue;
        reported.add(node);
        if (PHYSICAL_CLASS.test(value)) {
          context.report({ node, messageId: 'physical', data: { value: value.trim().slice(0, 60) } });
        }
      }
    };
    return {
      JSXAttribute(node) {
        if (node.name.name === 'className' && node.value) check(stringsIn(node.value));
      },
      CallExpression(node) {
        if (isClassHelperCall(node)) check(stringsIn(node));
      },
    };
  },
};

/** @type {import('eslint').Rule.RuleModule} */
const noHexColors = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow hard-coded hex colours in components; use Tailwind theme tokens.',
    },
    messages: {
      hex: 'Hard-coded hex colour "{{value}}". Use a theme token (e.g. bg-primary, text-muted-foreground).',
    },
    schema: [],
  },
  create(context) {
    const report = (node, value) =>
      context.report({ node, messageId: 'hex', data: { value: value.trim().slice(0, 40) } });
    // On JSX attributes only styling props can carry colours (href="#add" is an anchor, not a colour).
    const STYLING_ATTRS = new Set(['className', 'style', 'color', 'fill', 'stroke', 'stopColor']);
    return {
      Literal(node) {
        if (typeof node.value !== 'string' || !HEX_COLOR.test(node.value)) return;
        const parent = node.parent;
        if (parent?.type === 'JSXAttribute' && !STYLING_ATTRS.has(parent.name.name)) return;
        report(node, node.value);
      },
      TemplateElement(node) {
        const v = node.value.cooked ?? node.value.raw;
        if (HEX_COLOR.test(v)) report(node, v);
      },
    };
  },
};

const plugin = {
  meta: { name: '@loons/eslint-plugin' },
  rules: {
    'no-physical-direction-classes': noPhysicalDirectionClasses,
    'no-hex-colors': noHexColors,
  },
};

export default plugin;
export { PHYSICAL_CLASS, HEX_COLOR };
