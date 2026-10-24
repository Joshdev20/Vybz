import { migrate } from '../db/index.js';
import { seed, seedChallengesForToday } from '../db/seedData.js';

const applied = migrate();
seed();
seedChallengesForToday();
console.log(`[setup] migrations applied: ${applied}`);
