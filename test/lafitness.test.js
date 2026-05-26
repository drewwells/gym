const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseGrid, classifyRoom } = require('../providers/lafitness');

// A minimal fixture mirroring the real ClassSchedulePrintVersion.aspx markup:
// 7 day columns Sun..Sat (leading <td> spacer), <h5> time per row, and a
// multi-class cell separated by <br/>.
const FIXTURE = `
<table>
  <thead><tr>
    <td width="60" class="tableDataHeader">&nbsp;</td>
    <th scope="col">Sunday</th><th scope="col">Monday</th><th scope="col">Tuesday</th>
    <th scope="col">Wednesday</th><th scope="col">Thursday</th><th scope="col">Friday</th>
    <th scope="col">Saturday</th>
  </tr></thead>
  <tbody>
    <tr>
      <th scope="row"><h5>08:30 AM</h5></th>
      <td></td>
      <td><strong><a href="/Pages/ClassDescription.aspx?id=84">Zumba&reg; Class</a></strong> (Dennis)</td>
      <td></td><td></td><td></td>
      <td><strong><a href="/Pages/ClassDescription.aspx?id=84">Zumba&reg; Class</a></strong> (Muthu Meena)<br /><strong><a href="/Pages/ClassDescription.aspx?id=26">Aqua Fit</a></strong> (Mary)</td>
      <td><strong><a href="/Pages/ClassDescription.aspx?id=28">Yoga</a></strong> (Cathy)</td>
    </tr>
    <tr>
      <th scope="row"><h5>05:45 PM</h5></th>
      <td></td><td></td>
      <td><strong><a href="/Pages/ClassDescription.aspx?id=23">Cycle</a></strong> (Joey)</td>
      <td></td><td></td><td></td><td></td>
    </tr>
  </tbody>
</table>`;

test('parseGrid maps day columns, times, names and instructors', () => {
  const entries = parseGrid(FIXTURE);
  // 08:30: Mon Zumba, Fri Zumba, Fri Aqua, Sat Yoga = 4; 17:45: Tue Cycle = 1.
  assert.equal(entries.length, 5);

  const monZumba = entries.find((e) => e.dayIdx === 1 && e.hh === 8);
  assert.equal(monZumba.name, 'Zumba® Class'); // entity decoded
  assert.equal(monZumba.instructor, 'Dennis');
  assert.equal(monZumba.mm, 30);

  const tueCycle = entries.find((e) => e.dayIdx === 2);
  assert.equal(tueCycle.name, 'Cycle');
  assert.equal(tueCycle.hh, 17); // PM converted to 24h
});

test('parseGrid splits a multi-class (concurrent) cell', () => {
  const entries = parseGrid(FIXTURE);
  const friday = entries.filter((e) => e.dayIdx === 5);
  assert.deepEqual(friday.map((e) => e.name).sort(), ['Aqua Fit', 'Zumba® Class']);
});

test('classifyRoom: studio classes are dance-suitable, cycle/aqua are not', () => {
  for (const n of ['Zumba® Class', 'Yoga', 'Kickbox Cardio', 'BodyPump', 'Step', 'Mat Pilates']) {
    assert.equal(classifyRoom(n), 'Group Fitness Studio', `${n} should be studio`);
  }
  for (const n of ['Cycle', 'Cycle Zone', 'Cycle + Strength', 'Aqua Fit', 'Aqua Zumba']) {
    assert.equal(classifyRoom(n), 'Other', `${n} should be excluded`);
  }
});

test('classifyRoom defaults unknown class names to the studio (conservative)', () => {
  // An unrecognized class should block the floor, not falsely free it.
  assert.equal(classifyRoom('Some New Dance Format'), 'Group Fitness Studio');
});
