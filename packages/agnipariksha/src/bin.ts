#!/usr/bin/env node
/**
 * agnipariksha's bin. It holds no logic, so no suite owns it and the gate
 * reports it as not judged: what it runs is cli.ts's `entry`, which
 * cli.test.ts judges.
 */
import { entry } from './cli.ts';

await entry(process);
