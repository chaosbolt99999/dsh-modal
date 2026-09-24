#!/usr/bin/env node
/**
 * Entry point the shell executor invokes for a routed build command.
 *
 * Kept as a two-line shim so the real logic lives in typed, testable source
 * under `src/`; Node resolves the relative import against this file, so the
 * plugin works from any install location.
 */
import '../dist/cli.js'
