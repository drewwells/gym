const { test } = require('node:test');
const assert = require('node:assert/strict');

const { instructors } = require('../providers/crux');

test('instructors: staff names win when Crux fills them', () => {
  assert.deepEqual(
    instructors({ name: 'Trial Class- Rec Team', staff: [{ firstName: 'Susie ', lastName: 'Ruiz' }] }),
    ['Susie Ruiz'],
  );
});

test('instructors: otherwise parsed from "w/ Name" in the class name', () => {
  assert.deepEqual(instructors({ name: 'Vinyasa 2 w/ Jennifer C.', staff: [] }), ['Jennifer C.']);
  assert.deepEqual(instructors({ name: 'Sunrise CYoga w/Audrey (sub for Sunrise Vinyasa)' }), ['Audrey']);
  assert.deepEqual(instructors({ name: 'Queer Cuties Climb', staff: [] }), []);
});
