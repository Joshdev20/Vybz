import { migrate } from '../db/index.js';
import { seed, seedChallengesForToday } from '../db/seedData.js';

migrate();
seed();
seedChallengesForToday();
console.log('[seed] reference data ready');
