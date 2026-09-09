import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../apps/web/src/components/agent/GlobalAgentChatWidget.tsx', import.meta.url), 'utf8');
const logic = source.match(/  const greetingName = .*\n  const greeting = .*;/)?.[0];
assert.ok(logic);
assert.ok(source.includes('data-chat-greeting="profile-v1"'));
assert.ok(!source.includes('anh Tâm'));
const cases = [
  ['vi', {id:'a'}, {user_id:'a',full_name:'  Mai Nguyễn  '}, 'Xin chào, Mai Nguyễn.'],
  ['en', {id:'b'}, {user_id:'b',full_name:'Alex'}, 'Hello, Alex.'],
  ['vi', {id:'b'}, {user_id:'a',full_name:'Tâm'}, 'Xin chào.'],
  ['vi', {id:'a'}, null, 'Xin chào.'],
  ['en', {id:'a'}, {user_id:'a',full_name:'   ',email:'private@example.com'}, 'Hello.'],
  ['vi', {id:'a'}, {user_id:'a',full_name:null}, 'Xin chào.'],
  ['vi', null, {user_id:'a',full_name:'Tâm'}, 'Xin chào.'],
];
for (const [language,user,profile,expected] of cases) {
  assert.equal(runInNewContext(`${logic}\ngreeting`, {language,user,profile}), expected);
}
console.log('7 greeting cases passed (identity, locale, missing names, stale profile).');
