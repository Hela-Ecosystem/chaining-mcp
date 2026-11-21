import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkToolAvailability } from '../../dist/core/tool-availability.js';

const tools = [
  { name: 'read_file', serverName: 'hela-membrane' },
  { name: 'write_file', serverName: 'hela-membrane' },
  { name: 'search_nodes', serverName: 'hela-genome' },
];

test('a real tool on a discovered server verifies, and an invented one does not', () => {
  const { errors, warnings } = checkToolAvailability([
    { serverName: 'hela-membrane', toolName: 'read_file' },
    { serverName: 'hela-membrane', toolName: 'invented_tool' },
  ], tools);
  assert.deepEqual(errors, ["Tool 'invented_tool' is not available in server 'hela-membrane'"]);
  assert.deepEqual(warnings, []);
});

test('no catalog at all is a warning, not a blanket rejection', () => {
  const { errors, warnings } = checkToolAvailability([
    { serverName: 'hela-membrane', toolName: 'read_file' },
  ], []);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not be verified/);
});

test('a server that was not discovered downgrades to a warning', () => {
  const { errors, warnings } = checkToolAvailability([
    { serverName: 'awesome-copilot', toolName: 'search' },
  ], tools);
  assert.deepEqual(errors, []);
  assert.match(warnings[0], /server 'awesome-copilot' was not discovered/);
});

test('short server names resolve against hela- prefixed cells', () => {
  const { errors } = checkToolAvailability([
    { serverName: 'membrane', toolName: 'read_file' },
  ], tools);
  assert.deepEqual(errors, []);
});
