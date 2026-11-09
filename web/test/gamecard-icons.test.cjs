const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const angularRequire = createRequire(path.resolve(__dirname, '../../angular/package.json'));
angularRequire('@angular/compiler');
const { LucideAngularComponent, LucideIconProvider, LucideIconConfig, icons } = angularRequire('lucide-angular');

test('the cover menu uses real registered icons so nested card views can finish rendering', () => {
  const template = fs.readFileSync(path.resolve(__dirname, '../../angular/src/app/pages/library/components/gamecard/gamecard.component.html'), 'utf8');
  const provider = new LucideIconProvider(icons);
  const component = new LucideAngularComponent({}, {}, {}, [provider], new LucideIconConfig());
  for (const [, name] of template.matchAll(/<i-lucide\b[^>]*\bname="([^"]+)"/g))
    assert.ok(component.getIcon(component.toPascalCase(name)), `Unregistered icon interrupts card rendering: ${name}`);
});

test('Lucide reproduces the old runtime error and renders the replacement cover icon successfully', () => {
  const element = tag => ({ tag, attributes: [], childNodes: [], classList: { add() {} } });
  const host = element('host');
  const renderer = {
    setAttribute() {},
    createElement: element,
    appendChild(parent, child) { parent.childNodes.push(child); },
    removeChild(parent, child) { parent.childNodes = parent.childNodes.filter(item => item !== child); },
  };
  const component = new LucideAngularComponent({ nativeElement: host }, renderer, { markForCheck() {} },
    [new LucideIconProvider(icons)], new LucideIconConfig());
  component.name = 'image-search';
  assert.throws(() => component.ngOnChanges({ name: {} }), /image-search.*has not been provided/);
  assert.equal(host.childNodes.length, 0);
  component.name = 'scan-search';
  assert.doesNotThrow(() => component.ngOnChanges({ name: {} }));
  assert.equal(host.childNodes[0].tag, 'svg');
});
