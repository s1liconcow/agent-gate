#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/policy.test.mjs
