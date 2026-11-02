import { shortIdFor, toProjects } from './projects';
import { uniqueCollections } from './sync.service';

const row = (over: Record<string, unknown>) => ({
  project_id: 'p1',
  project_name: 'Spooky Bar',
  collection_id: 'c1',
  collection_name: 'Spooky Bar Club',
  chain: 'ethereum',
  contract_address: '0xABC',
  collection_type: 'erc721',
  short_id: null,
  standard: null,
  core: null,
  decimals: null,
  staking_contracts: null,
  token_names: null,
  ...over,
});

describe('holder analysis projects', () => {
  it('makes short ids from names, unique within the project', () => {
    const taken = new Set<string>();
    expect(shortIdFor('Spooky Bar Club!', taken)).toBe('spookybarclu');
    expect(shortIdFor('Spooky Bar Club', taken)).toBe('spookybarcl2');
    expect(shortIdFor('★', taken)).toBe('c');
  });

  it('fills defaults: ERC-721 is core, ERC-1155 is not, contracts lowercased', () => {
    const [p] = toProjects([
      row({}),
      row({ collection_id: 'c2', collection_name: 'Drinks', collection_type: 'erc1155', staking_contracts: ['0xDEF'] }),
    ]);
    expect(p.collections.map((c) => [c.id, c.core, c.contract])).toEqual([
      ['spookybarclu', true, '0xabc'],
      ['drinks', false, '0xabc'],
    ]);
    expect(p.collections[1].staking).toEqual([]); // staking only counts for ERC-721
  });

  it('uses saved settings, including an ERC-20 standard Nexus has no type for', () => {
    const [p] = toProjects([
      row({ short_id: 'sb', staking_contracts: ['0xDEF'] }),
      row({ collection_id: 'c2', collection_name: 'Token', collection_type: 'unknown', standard: 'erc20', short_id: 'tok' }),
    ]);
    expect(p.collections.map((c) => [c.id, c.standard, c.core, c.decimals])).toEqual([
      ['sb', 'erc721', true, 0],
      ['tok', 'erc20', false, 18],
    ]);
    expect(p.collections[0].staking).toEqual(['0xdef']);
  });

  it('treats every collection as core when none is, and skips Solana and unknown types', () => {
    const projects = toProjects([
      row({ collection_type: 'erc1155' }),
      row({ collection_id: 'c2', chain: 'solana' }),
      row({ collection_id: 'c3', collection_type: 'unknown' }),
      row({ project_id: 'p2', collection_id: 'c4', chain: 'solana' }),
    ]);
    expect(projects).toHaveLength(1);
    expect(projects[0].collections.map((c) => [c.collectionId, c.core])).toEqual([['c1', true]]);
  });

  it('follows a collection once across projects', () => {
    const [p] = toProjects([row({})]);
    const both = uniqueCollections([p, { ...p, id: 'p2', collections: p.collections.map((c) => ({ ...c, core: false })) }]);
    expect(both).toHaveLength(1);
    expect(both[0].core).toBe(true);
  });
});
