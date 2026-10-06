// A small element-only XPath dialect. No arbitrary XPath evaluator, attributes,
// text(), unions, parent axes, functions, scripts, frames, or shadow roots.
export function parseXPath(value) {
  if (typeof value !== 'string' || value.length > 256 || !value.startsWith('/') || /[\r\n]/.test(value)) throw new Error('Use a bounded element XPath.');
  const steps = []; let at = 0;
  while (at < value.length) {
    const axis = value.startsWith('//', at) ? 'descendant' : 'child'; at += axis === 'descendant' ? 2 : 1;
    const tag = /^(\*|[a-z][a-z0-9-]*)/.exec(value.slice(at));
    if (!tag) throw new Error('Expected an element tag.'); at += tag[0].length;
    const predicates = [];
    while (value[at] === '[') {
      const end = value.indexOf(']', at); if (end < 0 || predicates.length >= 2) throw new Error('Invalid XPath predicate.');
      const body = value.slice(at + 1, end);
      if (/^[1-9][0-9]{0,3}$/.test(body)) predicates.push({index: Number(body)});
      else {
        const attr = /^@(id|role|class)=(['"])([a-zA-Z0-9_ .:-]{1,80})\2$/.exec(body);
        if (!attr) throw new Error('Only an index or exact id, role or class predicate is supported.');
        predicates.push({attribute: attr[1], value: attr[3]});
      }
      at = end + 1;
    }
    steps.push({axis, tag: tag[0], predicates});
    if (steps.length > 12 || at < value.length && value[at] !== '/') throw new Error('Unsupported XPath syntax.');
  }
  if (!steps.length) throw new Error('XPath needs an element.');
  return steps;
}
export function selectElements(document, value) {
  const steps = parseXPath(value); let parents = [document], visited = 0;
  for (const step of steps) {
    const found = [];
    for (const parent of parents) {
      let nodes = step.axis === 'child' ? [...parent.children] : [...parent.querySelectorAll(step.tag)];
      visited += nodes.length;
      if (visited > 20000) throw new Error('XPath traversal limit reached.');
      nodes = nodes.filter(n => step.tag === '*' || n.localName === step.tag);
      for (const p of step.predicates) {
        if (!p.index) nodes = nodes.filter(n => n.getAttribute(p.attribute) === p.value);
        else if (step.axis === 'child') nodes = nodes.slice(p.index - 1, p.index);
        else {
          // //tag[index] applies position per parent, as XPath's abbreviated
          // descendant-or-self::node()/child::tag step does.
          const positions = new Map();
          nodes = nodes.filter(n => { const position = (positions.get(n.parentElement) || 0) + 1; positions.set(n.parentElement, position); return position === p.index; });
        }
      }
      found.push(...nodes); if (found.length > 2048) throw new Error('XPath match limit reached.');
    }
    parents = [...new Set(found)].sort((a,b) => a.compareDocumentPosition(b) & 2 ? 1 : -1);
  }
  return parents;
}
export function elementPath(node) {
  const path = [];
  for (let n = node; n?.nodeType === 1; n = n.parentElement) {
    let index = 1;
    for (let previous = n.previousElementSibling; previous; previous = previous.previousElementSibling) if (previous.localName === n.localName) index++;
    path.unshift(`${n.localName}[${index}]`);
  }
  const result = '/' + path.join('/');
  return result.length <= 256 ? result : null;
}
