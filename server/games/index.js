import { rizzBattle } from './rizzBattle.js';
import { wordChemistry } from './wordChemistry.js';

/** Registry of queue-based, round-driven game modules. */
export const GAME_MODULES = {
  [rizzBattle.key]: rizzBattle,
  [wordChemistry.key]: wordChemistry,
};

export function gameModule(key) {
  return GAME_MODULES[key] || null;
}

export function isRoundGame(key) {
  return Boolean(GAME_MODULES[key]);
}
