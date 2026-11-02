import { slugify } from './admin-projects.service';

describe('slugify', () => {
  it('lowercases and joins words with dashes', () => {
    expect(slugify('Spooky Boys Country Club')).toBe('spooky-boys-country-club');
  });

  it('drops accents and punctuation, and trims dashes', () => {
    expect(slugify('  Café — Déjà Vu!! ')).toBe('cafe-deja-vu');
  });

  it('returns an empty string when nothing is left', () => {
    expect(slugify('!!!')).toBe('');
  });
});
