const test=require('node:test'),assert=require('node:assert/strict');
const clock=require('../web/timezones.js');
test('defaults to server zone regardless of browser host zone; override takes priority',()=>{
 const now=new Date('2026-10-07T16:00:00Z'),server={time_zone:'Asia/Seoul'};
 assert.equal(clock.parts(now,'',server).date,'2026-10-08');
 assert.equal(clock.parts(now,'America/Los_Angeles',server).date,'2026-10-07');
 assert.equal(clock.parts(now,'invalid-zone',server).hour,'01');
});
test('DST uses IANA rules and fixed server offset is available without zone identity',()=>{
 assert.equal(clock.parts(new Date('2026-03-08T06:59:00Z'),'America/New_York').hour,'01');
 assert.equal(clock.parts(new Date('2026-03-08T07:00:00Z'),'America/New_York').hour,'03');
 assert.equal(clock.parts(new Date('2026-10-07T20:00:00Z'),'',{offset_minutes:330}).date,'2026-10-08');
 assert.equal(clock.parts(new Date('2026-10-07T20:00:00Z'),'',{offset_minutes:330}).minute,'30');
});
test('zone menu includes UTC, server aliases and valid IANA names',()=>{
 assert.ok(clock.zones(['Asia/Seoul','invalid']).includes('Asia/Seoul'));
 assert.ok(clock.zones().includes('UTC'));assert.ok(!clock.zones(['invalid']).includes('invalid'));
});
