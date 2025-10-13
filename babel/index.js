'use strict';

const compiled = require('../dist/index.js');
const exported = compiled && compiled.default ? compiled.default : compiled;

module.exports = exported;

if (compiled && typeof compiled === 'object') {
  Object.keys(compiled).forEach((key) => {
    if (key !== 'default') {
      module.exports[key] = compiled[key];
    }
  });
}
