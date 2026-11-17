import { migrateCliMain } from './migrate.js';

process.exit(await migrateCliMain(process.env));
