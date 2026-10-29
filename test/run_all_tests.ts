import {
  initDatabase,
  createGroup,
  renameGroup,
  deleteGroup,
  getAllGroups,
  addWallet,
  removeWallet,
  getAllWallets,
  clearAllWallets,
  bulkAddWalletsToGroup,
  addWalletToGroup,
  removeWalletFromGroup,
  getWalletGroups,
  recordProcessedEvent,
  isEventProcessed,
  saveAlertHistory,
  getAlertHistory,
  clearAllAlerts,
  getAchievedMilestones,
  recordMilestoneAlerted,
  ALERT_THRESHOLDS,
  exportWalletsBackup,
  restoreWalletsFromBackup,
  closeDatabase,
} from '../src/server/database/db.ts';
import { validateWalletAddress } from '../src/server/services/walletValidation.ts';
import { OpenSeaService } from '../src/server/services/openseaService.ts';
import { AlertConsolidator } from '../src/server/services/alertConsolidator.ts';
import { getPollIntervalSeconds, monitorService } from '../src/server/services/monitorService.ts';
import fs from 'node:fs';
import path from 'node:path';

export interface TestResult {
  title: string;
  category: string;
  passed: boolean;
  message?: string;
  durationMs: number;
}

export async function runAllTests(): Promise<{ results: TestResult[]; summary: { total: number; passed: number; failed: number } }> {
  const results: TestResult[] = [];
  closeDatabase();
  const testDbPath = './data/test_nft_bot.sqlite';

  // Ensure test db starts fresh
  for (const f of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
  }

  const db = initDatabase(testDbPath);
  clearAllWallets(db);
  db.prepare(`
    INSERT OR IGNORE INTO groups (id, name, description, created_at, is_enabled)
    VALUES
      ('grp_alpha', 'Alpha', 'Top performing NFT traders', 1000, 1),
      ('grp_whales', 'Whales', 'High-volume liquidity holders', 1000, 1)
  `).run();
  const consolidator = new AlertConsolidator();
  const opensea = new OpenSeaService('test_mock_key');

  const record = (title: string, category: string, fn: () => void | Promise<void>) => {
    const start = Date.now();
    try {
      const res = fn();
      if (res instanceof Promise) {
        return res
          .then(() => {
            results.push({ title, category, passed: true, durationMs: Date.now() - start });
          })
          .catch((err) => {
            results.push({ title, category, passed: false, message: err.message, durationMs: Date.now() - start });
          });
      }
      results.push({ title, category, passed: true, durationMs: Date.now() - start });
    } catch (err: any) {
      results.push({ title, category, passed: false, message: err.message, durationMs: Date.now() - start });
    }
    return Promise.resolve();
  };

  // 1. Group Management: Create, Rename, Delete by ID and by Name
  await record('Create, rename, and delete groups by ID and by Name', 'Groups', () => {
    const groupName = 'DeFi Snipers';
    const group = createGroup(groupName, 'High-conviction snipers', db);
    if (!group.id || group.name !== groupName) throw new Error('Group creation failed');

    const renamed = renameGroup(group.id, 'Alpha Snipers', db);
    if (!renamed) throw new Error('Group rename failed');

    const groups = getAllGroups(db);
    const found = groups.find((g) => g.id === group.id);
    if (!found || found.name !== 'Alpha Snipers') throw new Error('Renamed group not found in DB');

    // Test deleting by name (simplifying user experience)
    const easyGrp = createGroup('Custom Whale Group', 'A group to delete by name', db);
    const deletedByName = deleteGroup('Custom Whale Group', db);
    if (!deletedByName) throw new Error('Failed to delete group by its name');

    const deleted = deleteGroup(group.id, db);
    if (!deleted) throw new Error('Group delete failed');

    const afterDelete = getAllGroups(db).find((g) => g.id === group.id);
    if (afterDelete) throw new Error('Deleted group still exists');
  });

  // 2. Wallets: Add and Remove
  await record('Adding and removing wallets', 'Wallets', () => {
    const testAddr = '0x1111111111111111111111111111111111111111';
    addWallet(testAddr, 'Test Minter', 'evm', [], db);

    const wallets = getAllWallets(db);
    const added = wallets.find((w) => w.address === testAddr.toLowerCase());
    if (!added) throw new Error('Wallet was not found after addition');

    const removed = removeWallet(testAddr, db);
    if (!removed) throw new Error('Wallet removal failed');

    const afterRemove = getAllWallets(db).find((w) => w.address === testAddr.toLowerCase());
    if (afterRemove) throw new Error('Removed wallet still present');
  });

  // 3. Wallets Belonging to Multiple Groups
  await record('Wallets belonging to multiple groups', 'Memberships', () => {
    const multiAddr = '0x2222222222222222222222222222222222222222';
    const g1 = createGroup('Test Group A', 'Group A', db);
    const g2 = createGroup('Test Group B', 'Group B', db);

    addWallet(multiAddr, 'Multi Holder', 'evm', [g1.id, g2.id], db);

    const userGroups = getWalletGroups(multiAddr, db);
    if (userGroups.length !== 2) throw new Error(`Expected 2 groups, got ${userGroups.length}`);

    const hasG1 = userGroups.some((g) => g.id === g1.id);
    const hasG2 = userGroups.some((g) => g.id === g2.id);
    if (!hasG1 || !hasG2) throw new Error('Wallet does not contain both groups');
  });

  // 4. Removing wallet from one group preserves membership in others
  await record('Removing a wallet from one group preserves membership in others', 'Memberships', () => {
    const addr = '0x3333333333333333333333333333333333333333';
    const g1 = createGroup('Preserve G1', '', db);
    const g2 = createGroup('Preserve G2', '', db);

    addWallet(addr, 'Preserve Test', 'evm', [g1.id, g2.id], db);
    removeWalletFromGroup(addr, g1.id, db);

    const remainingGroups = getWalletGroups(addr, db);
    if (remainingGroups.length !== 1 || remainingGroups[0].id !== g2.id) {
      throw new Error(`Expected only G2 to remain, found: ${remainingGroups.map((g) => g.name).join(', ')}`);
    }
  });

  // 5. Detecting Genuine Mints
  await record('Detecting genuine mints (zero-address sender or mint event)', 'Activity Detection', () => {
    const trackedAddr = '0x4444444444444444444444444444444444444444';

    // Transfer from 0x0 is a mint
    const rawMintEvent1 = {
      event_id: 'mint_test_1',
      event_type: 'transfer',
      from_address: '0x0000000000000000000000000000000000000000',
      to_address: trackedAddr,
      chain: 'ethereum',
      collection: 'azuki',
      quantity: 2,
    };
    const classified1 = opensea.classifyEvent(rawMintEvent1, trackedAddr);
    if (!classified1 || classified1.event_type !== 'mint') {
      throw new Error('Failed to classify transfer from 0x0 address as mint');
    }
    if (classified1.quantity !== 2) throw new Error('Incorrect quantity on mint event');

    // Explicit event_type: mint
    const rawMintEvent2 = {
      event_id: 'mint_test_2',
      event_type: 'mint',
      to_address: trackedAddr,
      chain: 'base',
      collection: 'base-apes',
      quantity: 1,
    };
    const classified2 = opensea.classifyEvent(rawMintEvent2, trackedAddr);
    if (!classified2 || classified2.event_type !== 'mint') {
      throw new Error('Failed to classify explicit mint event');
    }
  });

  // 6. Detecting Genuine Purchases
  await record('Detecting genuine purchases (tracked wallet is buyer)', 'Activity Detection', () => {
    const trackedAddr = '0x5555555555555555555555555555555555555555';

    const saleEvent = {
      event_id: 'sale_test_1',
      event_type: 'sale',
      buyer: trackedAddr,
      seller: '0x9999999999999999999999999999999999999999',
      chain: 'ethereum',
      collection: 'pudgypenguins',
      quantity: 1,
    };

    const classified = opensea.classifyEvent(saleEvent, trackedAddr);
    if (!classified || classified.event_type !== 'sale') {
      throw new Error('Failed to classify genuine purchase where tracked wallet is buyer');
    }
  });

  // 7. Excluding Ordinary Transfers
  await record('Excluding ordinary transfers between non-zero addresses', 'Activity Detection', () => {
    const trackedAddr = '0x6666666666666666666666666666666666666666';

    const ordinaryTransfer = {
      event_id: 'transfer_test_1',
      event_type: 'transfer',
      from_address: '0x8888888888888888888888888888888888888888',
      to_address: trackedAddr,
      chain: 'ethereum',
      collection: 'doodles',
      quantity: 1,
    };

    const classified = opensea.classifyEvent(ordinaryTransfer, trackedAddr);
    if (classified !== null) {
      throw new Error('Ordinary transfer between non-zero addresses was incorrectly classified!');
    }
  });

  // 8. Excluding sales initiated by tracked wallets (tracked wallet is seller)
  await record('Excluding sales initiated by tracked wallets (wallet is seller, not buyer)', 'Activity Detection', () => {
    const trackedAddr = '0x7777777777777777777777777777777777777777';

    const sellEvent = {
      event_id: 'sell_test_1',
      event_type: 'sale',
      seller: trackedAddr,
      buyer: '0x1234123412341234123412341234123412341234',
      chain: 'ethereum',
      collection: 'coolcats',
      quantity: 1,
    };

    const classified = opensea.classifyEvent(sellEvent, trackedAddr);
    if (classified !== null) {
      throw new Error('Sale initiated by tracked wallet was incorrectly treated as a purchase!');
    }
  });

  // 9. Multi-Group Deduplication & Statistics Accuracy (Core Requirement 4 & 5)
  await record('Consolidating multi-group alerts without double-counting wallets or NFTs', 'Statistics & Alerts', () => {
    // Setup test:
    // Group Alpha: Wallet A, Wallet B, Wallet C
    // Group Whales: Wallet C, Wallet D
    // Notice Wallet C belongs to BOTH Alpha and Whales!
    const gAlpha = createGroup('Stats Alpha', '', db);
    const gWhales = createGroup('Stats Whales', '', db);

    const wA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const wB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const wC = '0xcccccccccccccccccccccccccccccccccccccccc'; // overlap!
    const wD = '0xdddddddddddddddddddddddddddddddddddddddd';

    addWallet(wA, 'A', 'evm', [gAlpha.id], db);
    addWallet(wB, 'B', 'evm', [gAlpha.id], db);
    addWallet(wC, 'C', 'evm', [gAlpha.id, gWhales.id], db);
    addWallet(wD, 'D', 'evm', [gWhales.id], db);

    // Activity:
    // wA mints 5 NFTs (1 event)
    // wB mints 4 NFTs (1 event)
    // wC mints 3 NFTs (1 event)
    // wD mints 2 NFTs (1 event)
    // Group Alpha should see: 3 Minters (A, B, C) | 12 NFTs (5 + 4 + 3)
    // Group Whales should see: 2 Minters (C, D) | 5 NFTs (3 + 2)
    // Total Unique Wallets across both = 4 (A, B, C, D) -- NOT 5!
    // Total NFTs Minted = 14 (5 + 4 + 3 + 2) -- NOT 17 (which would double count C's 3 NFTs)!

    const events = [
      {
        event_id: 'ev_a',
        event_type: 'mint' as const,
        chain: 'ethereum',
        collection_slug: 'quantum-cats',
        wallet_address: wA,
        quantity: 5,
        timestamp: Date.now(),
      },
      {
        event_id: 'ev_b',
        event_type: 'mint' as const,
        chain: 'ethereum',
        collection_slug: 'quantum-cats',
        wallet_address: wB,
        quantity: 4,
        timestamp: Date.now(),
      },
      {
        event_id: 'ev_c',
        event_type: 'mint' as const,
        chain: 'ethereum',
        collection_slug: 'quantum-cats',
        wallet_address: wC,
        quantity: 3,
        timestamp: Date.now(),
      },
      {
        event_id: 'ev_d',
        event_type: 'mint' as const,
        chain: 'ethereum',
        collection_slug: 'quantum-cats',
        wallet_address: wD,
        quantity: 2,
        timestamp: Date.now(),
      },
    ];

    const alerts = consolidator.consolidateEvents(
      events,
      {
        'quantum-cats': {
          slug: 'quantum-cats',
          name: 'Quantum Cats',
          chain: 'ethereum',
          opensea_url: 'https://opensea.io/collection/quantum-cats',
          twitter_url: 'https://x.com/QuantumCatsXYZ',
          discord_url: 'https://discord.gg/quantumcats',
          updated_at: Date.now(),
        },
      },
      db
    );

    if (alerts.length !== 1) throw new Error(`Expected 1 consolidated alert, got ${alerts.length}`);
    const alert = alerts[0];

    // Check unique wallets
    if (alert.totalUniqueWallets !== 4) {
      throw new Error(`Total unique wallets was ${alert.totalUniqueWallets}, expected 4 (deduplicated)`);
    }

    // Check total NFTs
    if (alert.totalNFTs !== 14) {
      throw new Error(`Total NFTs was ${alert.totalNFTs}, expected 14 (avoiding double count of overlapping wallet)`);
    }

    // Check individual groups
    const alphaSummary = alert.groups.find((g) => g.groupId === gAlpha.id);
    const whalesSummary = alert.groups.find((g) => g.groupId === gWhales.id);

    if (!alphaSummary || alphaSummary.uniqueCount !== 3 || alphaSummary.nftsCount !== 12) {
      throw new Error(`Alpha group stats incorrect: ${JSON.stringify(alphaSummary)}`);
    }

    if (!whalesSummary || whalesSummary.uniqueCount !== 2 || whalesSummary.nftsCount !== 5) {
      throw new Error(`Whales group stats incorrect: ${JSON.stringify(whalesSummary)}`);
    }

    // Check exact required message formatting
    if (!alert.formattedMessage.includes('🔥 SMART MONEY MINT')) {
      throw new Error('Header title missing 🔥 SMART MONEY MINT');
    }
    if (!alert.formattedMessage.includes('4 Unique Wallets | 14 NFTs Minted')) {
      throw new Error('Total line format incorrect: ' + alert.formattedMessage);
    }
    if (!alert.formattedMessage.includes('📁 Stats Alpha — 3 Minters | 12 NFTs')) {
      throw new Error('Alpha group line format incorrect: ' + alert.formattedMessage);
    }
    if (!alert.formattedMessage.includes('📁 Stats Whales — 2 Minters | 5 NFTs')) {
      throw new Error('Whales group line format incorrect: ' + alert.formattedMessage);
    }
    if (!alert.formattedMessage.includes('🔗 OpenSea: https://opensea.io/collection/quantum-cats')) {
      throw new Error('OpenSea link missing or incorrect');
    }
    if (!alert.formattedMessage.includes('[X/Twitter](https://x.com/QuantumCatsXYZ)')) {
      throw new Error('Socials link missing or incorrect');
    }
  });

  // 10. Purchase Alert Formatting (Section 6)
  await record('Formatting NFT Purchase alerts correctly (🔥 SMART MONEY BUY)', 'Alert Formatting', () => {
    const gAlpha = getAllGroups(db)[0];
    const testBuyer1 = '0x1111111111111111111111111111111111111111';
    const testBuyer2 = '0x2222222222222222222222222222222222222222';
    const testBuyer3 = '0x3333333333333333333333333333333333333333';
    addWallet(testBuyer1, 'Buyer 1', 'evm', [gAlpha.id], db);
    addWallet(testBuyer2, 'Buyer 2', 'evm', [gAlpha.id], db);
    addWallet(testBuyer3, 'Buyer 3', 'evm', [gAlpha.id], db);

    const events = [
      {
        event_id: 'buy_ev_1',
        event_type: 'sale' as const,
        chain: 'ethereum',
        collection_slug: 'milady',
        wallet_address: testBuyer1,
        quantity: 2,
        timestamp: Date.now(),
      },
      {
        event_id: 'buy_ev_2',
        event_type: 'sale' as const,
        chain: 'ethereum',
        collection_slug: 'milady',
        wallet_address: testBuyer2,
        quantity: 1,
        timestamp: Date.now(),
      },
      {
        event_id: 'buy_ev_3',
        event_type: 'sale' as const,
        chain: 'ethereum',
        collection_slug: 'milady',
        wallet_address: testBuyer3,
        quantity: 1,
        timestamp: Date.now(),
      },
    ];

    const alerts = consolidator.consolidateEvents(
      events,
      {
        milady: {
          slug: 'milady',
          name: 'Milady Maker',
          chain: 'ethereum',
          opensea_url: 'https://opensea.io/collection/milady',
          updated_at: Date.now(),
        },
      },
      db
    );

    if (alerts.length !== 1) throw new Error('Expected 1 buy alert');
    const msg = alerts[0].formattedMessage;

    if (!msg.includes('🔥 SMART MONEY BUY')) throw new Error('Buy header missing');
    if (!msg.includes('Buyers')) throw new Error('Expected "Buyers" in group row');
    if (!msg.includes('NFTs Bought')) throw new Error('Expected "NFTs Bought" in total line');
    if (!msg.includes('⚡ Activity: NFT Purchase')) throw new Error('Expected Activity: NFT Purchase');
    if (!msg.includes('THRESHOLD REACHED: 3 UNIQUE WALLETS!')) throw new Error('Expected milestone badge in message');
  });

  // 11. Handling Missing Socials Gracefully
  await record('Handling missing social links without failing alert delivery', 'Socials & Links', () => {
    const formatted = consolidator.formatTelegramMessage({
      alertType: 'mint',
      collectionName: 'No Socials Project',
      chain: 'base',
      groupSummaries: [{ groupId: 'g1', groupName: 'Alpha', uniqueCount: 1, nftsCount: 1 }],
      totalUniqueWallets: 1,
      totalNFTs: 1,
      openseaUrl: 'https://opensea.io/collection/no-socials',
      socials: {}, // empty socials
    });

    if (!formatted.includes('🌐 Socials: None listed')) {
      throw new Error('Expected graceful "None listed" fallback when socials are missing');
    }
    if (!formatted.includes('⛓️ Chain: Base')) {
      throw new Error('Expected properly capitalized chain "Base"');
    }
  });

  // 12. Preventing Duplicate Events across retrieval cycles
  await record('Preventing duplicate events across retrieval cycles', 'Deduplication', () => {
    const eventId = 'unique_tx_001_1';
    if (isEventProcessed(eventId, db)) throw new Error('Event should not be processed yet');

    recordProcessedEvent(
      {
        eventId,
        eventType: 'mint',
        chain: 'ethereum',
        collectionSlug: 'cryptopunks',
        walletAddress: '0x1234567890123456789012345678901234567890',
        quantity: 1,
        timestamp: Date.now(),
      },
      db
    );

    if (!isEventProcessed(eventId, db)) {
      throw new Error('Recorded event was not marked as processed');
    }

    // Second check to ensure it returns true and avoids duplicate processing
    const duplicate = isEventProcessed(eventId, db);
    if (!duplicate) throw new Error('Duplicate check failed');
  });

  // 13. Address Format Validation (EVM & Solana)
  await record('Address format validation for EVM and Solana', 'Validation', () => {
    // Valid EVM
    const evmValid = validateWalletAddress('0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
    if (!evmValid.isValid || evmValid.chainType !== 'evm') throw new Error('Valid EVM was rejected');

    // Invalid EVM (bad length)
    const evmInvalid = validateWalletAddress('0x12345');
    if (evmInvalid.isValid) throw new Error('Invalid EVM address was accepted');

    // Valid Solana
    const solValid = validateWalletAddress('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
    if (!solValid.isValid || solValid.chainType !== 'solana') throw new Error('Valid Solana address was rejected');

    // Empty
    const empty = validateWalletAddress('');
    if (empty.isValid) throw new Error('Empty address was accepted');
  });

  // 14. Preserving Data Across Restarts (SQLite persistence)
  await record('Preserving data across restarts in SQLite persistent disk', 'Persistence', () => {
    const testKey = '0x9999999999999999999999999999999999999999';
    addWallet(testKey, 'Persistence Check', 'evm', [], db);

    // Close and reopen database
    closeDatabase();
    const reopenedDb = initDatabase(testDbPath);

    const wallets = getAllWallets(reopenedDb);
    const persisted = wallets.find((w) => w.address === testKey);
    if (!persisted || persisted.label !== 'Persistence Check') {
      throw new Error('Data did not survive database close and reopen');
    }
  });

  // 15. Adding multiple wallets to a group at once (Bulk add)
  await record('Adding multiple wallets to a group at once', 'Bulk Operations', () => {
    const bulkGroup = createGroup('Bulk Alpha', 'Bulk testing', db);
    const inputs = [
      { address: '0x1212121212121212121212121212121212121212', label: 'Bulk 1' },
      { address: '0x3434343434343434343434343434343434343434', label: 'Bulk 2' },
      { address: '0x5656565656565656565656565656565656565656', label: 'Bulk 3' },
      { address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', label: 'Solana Whale' },
      { address: 'invalid_address_format', label: 'Bad' },
    ];

    const bulkResult = bulkAddWalletsToGroup(bulkGroup.id, inputs, db);
    if (bulkResult.addedCount !== 4) {
      throw new Error(`Expected 4 valid wallets added, got ${bulkResult.addedCount}`);
    }
    if (bulkResult.errors.length !== 1) {
      throw new Error(`Expected 1 invalid address error, got ${bulkResult.errors.length}`);
    }

    const groupWallets = getAllWallets(db).filter((w) => w.groups?.includes(bulkGroup.id));
    if (groupWallets.length !== 4) {
      throw new Error(`Expected 4 wallets in bulkGroup, got ${groupWallets.length}`);
    }
  });

  // 16. Deleting and removing all wallets (Clear all wallets)
  await record('Deleting and removing all tracked wallets', 'Bulk Operations', () => {
    const initialCount = getAllWallets(db).length;
    if (initialCount === 0) throw new Error('Expected wallets to exist before clear');

    const clearedCount = clearAllWallets(db);
    if (clearedCount !== initialCount) {
      throw new Error(`Expected ${initialCount} cleared, got ${clearedCount}`);
    }

    const afterWallets = getAllWallets(db);
    if (afterWallets.length !== 0) {
      throw new Error(`Expected 0 wallets after clearAllWallets, found ${afterWallets.length}`);
    }
  });

  // 17. Foreign Key Safety: Adding wallets with group names, case-insensitive names, and multi-address inputs
  await record('Preventing FOREIGN KEY constraint failures when adding wallets', 'Database Safety', () => {
    db.prepare('DELETE FROM groups WHERE LOWER(name) = ?').run('alpha');
    db.prepare(`
      INSERT OR REPLACE INTO groups (id, name, description, created_at, is_enabled)
      VALUES ('grp_alpha', 'Alpha', 'Top performing NFT traders', 1000, 1)
    `).run();

    // 1. Add wallet specifying group NAME ('Alpha') instead of group ID ('grp_alpha')
    const w1 = addWallet('0x9999999999999999999999999999999999999999', 'FK Test 1', 'evm', ['Alpha'], db);
    if (!w1.groups?.includes('grp_alpha')) {
      throw new Error('Expected wallet to resolve "Alpha" name to "grp_alpha" group ID');
    }

    // 2. Add wallet to group using addWalletToGroup with group name
    const addedToWhales = addWalletToGroup('0x9999999999999999999999999999999999999999', 'Whales', db);
    if (!addedToWhales) throw new Error('Failed adding wallet to group via name');

    // 3. Bulk add with address passed as target group without specifying group name
    const bulkRes = bulkAddWalletsToGroup(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      [{ address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
      db
    );
    if (bulkRes.addedCount < 2) {
      throw new Error(`Expected at least 2 wallets added, got ${bulkRes.addedCount}`);
    }

    // 4. Add wallet with address passed in groupIds (accidental multi-address passed to /addwallet)
    const wMulti = addWallet(
      '0xcccccccccccccccccccccccccccccccccccccccc',
      'Multi Accidental',
      'evm',
      ['0xdddddddddddddddddddddddddddddddddddddddd'],
      db
    );
    if (!wMulti) throw new Error('addWallet failed with address in groupIds');
  });

  // 18. Polling Interval Configuration (10s target)
  await record('Configuring and validating 10-second polling interval', 'Monitoring', () => {
    // Check helper parsing & normalization
    const intervalSec = getPollIntervalSeconds();
    if (intervalSec !== 10 && intervalSec < 5) {
      throw new Error(`Expected poll interval to be normalized to >= 5s, got ${intervalSec}`);
    }

    // Check dynamic interval update
    const updated = monitorService.setIntervalSeconds(10);
    if (updated !== 10) {
      throw new Error(`Expected updated interval to be 10, got ${updated}`);
    }

    if (monitorService.getStatus().pollIntervalMs !== 10000) {
      throw new Error(`Expected pollIntervalMs to be 10000ms, got ${monitorService.getStatus().pollIntervalMs}`);
    }
  });

  // 19. Threshold Milestone Alerting: 3, 6, 10, 15 Unique Wallets Enforcement
  await record('Threshold Milestone Alerting: 3, 6, 10, 15 unique wallets enforcement', 'Threshold Alerting', () => {
    const slug = 'threshold-test-collection';
    const chain = 'ethereum';

    // Clear any previous records
    clearAllAlerts(db);

    // Step A: 1 and 2 wallets must NOT produce an alert
    const oneWallet = getAchievedMilestones(slug, chain, 'mint', 1, db);
    if (oneWallet.eligibleMilestones.length !== 0) {
      throw new Error(`Expected 0 milestones for 1 wallet, got ${oneWallet.eligibleMilestones.length}`);
    }

    const twoWallets = getAchievedMilestones(slug, chain, 'mint', 2, db);
    if (twoWallets.eligibleMilestones.length !== 0) {
      throw new Error(`Expected 0 milestones for 2 wallets, got ${twoWallets.eligibleMilestones.length}`);
    }

    // Step B: 3 wallets reaches Milestone 1 (threshold 3)
    const threeWallets = getAchievedMilestones(slug, chain, 'mint', 3, db);
    if (threeWallets.eligibleMilestones.length !== 1 || threeWallets.eligibleMilestones[0] !== 3) {
      throw new Error(`Expected milestone [3], got ${JSON.stringify(threeWallets.eligibleMilestones)}`);
    }

    // Record milestone 3 as alerted
    recordMilestoneAlerted(slug, chain, 'mint', 3, db);

    // Step C: 4 or 5 wallets should NOT produce another alert since milestone 3 was alerted and milestone 6 is not reached
    const fourWallets = getAchievedMilestones(slug, chain, 'mint', 4, db);
    if (fourWallets.eligibleMilestones.length !== 0) {
      throw new Error(`Expected 0 unnotified milestones for 4 wallets, got ${JSON.stringify(fourWallets.eligibleMilestones)}`);
    }
    const fiveWallets = getAchievedMilestones(slug, chain, 'mint', 5, db);
    if (fiveWallets.eligibleMilestones.length !== 0) {
      throw new Error(`Expected 0 unnotified milestones for 5 wallets, got ${JSON.stringify(fiveWallets.eligibleMilestones)}`);
    }

    // Step D: 6 wallets reaches Milestone 2 (threshold 6)
    const sixWallets = getAchievedMilestones(slug, chain, 'mint', 6, db);
    if (sixWallets.eligibleMilestones.length !== 1 || sixWallets.eligibleMilestones[0] !== 6) {
      throw new Error(`Expected milestone [6], got ${JSON.stringify(sixWallets.eligibleMilestones)}`);
    }
    recordMilestoneAlerted(slug, chain, 'mint', 6, db);

    // Step E: 10 wallets reaches Milestone 3 (threshold 10)
    const tenWallets = getAchievedMilestones(slug, chain, 'mint', 10, db);
    if (tenWallets.eligibleMilestones.length !== 1 || tenWallets.eligibleMilestones[0] !== 10) {
      throw new Error(`Expected milestone [10], got ${JSON.stringify(tenWallets.eligibleMilestones)}`);
    }
    recordMilestoneAlerted(slug, chain, 'mint', 10, db);

    // Step F: 15 wallets reaches Milestone 4 (threshold 15)
    const fifteenWallets = getAchievedMilestones(slug, chain, 'mint', 15, db);
    if (fifteenWallets.eligibleMilestones.length !== 1 || fifteenWallets.eligibleMilestones[0] !== 15) {
      throw new Error(`Expected milestone [15], got ${JSON.stringify(fifteenWallets.eligibleMilestones)}`);
    }
    recordMilestoneAlerted(slug, chain, 'mint', 15, db);

    // No further milestones beyond 15
    const sixteenWallets = getAchievedMilestones(slug, chain, 'mint', 16, db);
    if (sixteenWallets.eligibleMilestones.length !== 0) {
      throw new Error(`Expected 0 unnotified milestones for 16 wallets, got ${JSON.stringify(sixteenWallets.eligibleMilestones)}`);
    }
  });

  // 20. Clear All Alerts & Reset Milestones
  await record('Purging all alert history and resetting milestone records', 'Threshold Alerting', () => {
    const slug = 'reset-test-collection';
    const chain = 'ethereum';

    // Record milestone 3
    recordMilestoneAlerted(slug, chain, 'buy', 3, db);

    // Save alert history
    saveAlertHistory({
      id: 'test_alert_reset',
      alertType: 'buy',
      collectionSlug: slug,
      collectionName: 'Reset Test',
      chain,
      totalUniqueWallets: 3,
      totalNFTs: 5,
      eventsCount: 3,
      groups: [{ groupName: 'Alpha', groupId: 'grp_alpha', uniqueCount: 3, nftsCount: 5 }],
      timestamp: Date.now(),
      formattedMessage: 'Test alert',
      openseaUrl: 'https://opensea.io/collection/reset-test',
      socials: {},
      milestone: 3,
      nextMilestone: 6,
    }, db);

    const beforeAlerts = getAlertHistory(undefined, 10, db);
    if (beforeAlerts.length === 0) throw new Error('Expected alert history to have items before clear');

    // Run clearAllAlerts
    const clearedCount = clearAllAlerts(db);
    if (clearedCount < 1) throw new Error(`Expected clearedCount >= 1, got ${clearedCount}`);

    const afterAlerts = getAlertHistory(undefined, 10, db);
    if (afterAlerts.length !== 0) throw new Error(`Expected 0 alerts after clear, got ${afterAlerts.length}`);

    // Milestone 3 should now be available again since table was cleared
    const unnotified = getAchievedMilestones(slug, chain, 'buy', 3, db);
    if (unnotified.eligibleMilestones.length !== 1 || unnotified.eligibleMilestones[0] !== 3) {
      throw new Error(`Expected milestone 3 to be available again after reset, got ${JSON.stringify(unnotified.eligibleMilestones)}`);
    }
  });

  // 21. Persistent Backup & Auto-Recovery (VPS power-off / container recreation protection)
  await record('Persistent wallet backup export and auto-restore on database re-mount', 'VPS Persistence', () => {
    // 1. Add sample wallets and groups
    const g = createGroup('Persistence Test Group', 'Test Desc', db);
    const testAddr = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    addWallet(testAddr, 'Persistence Wallet', 'evm', [g.id], db);

    // 2. Export backup
    const backup = exportWalletsBackup(db);
    if (!backup.wallets.some((w) => w.address === testAddr)) {
      throw new Error('Exported backup missing test wallet');
    }
    if (!backup.groups.some((grp) => grp.id === g.id)) {
      throw new Error('Exported backup missing test group');
    }

    // 3. Simulate VPS restart with clean/wiped database
    clearAllWallets(db);
    const wipedWallets = getAllWallets(db);
    if (wipedWallets.length !== 0) throw new Error('Expected 0 wallets after simulated wipe');

    // 4. Restore from backup
    const restored = restoreWalletsFromBackup(backup, db);
    if (restored.restoredWallets < 1) throw new Error('Failed to restore wallet from backup');

    const recoveredWallets = getAllWallets(db);
    const found = recoveredWallets.find((w) => w.address === testAddr);
    if (!found) throw new Error('Restored wallet not found in database');
    if (!found.groups?.includes(g.id)) throw new Error('Restored wallet missing group membership');
  });

  // 22. Cumulative Milestone Alerting Across Separate Polling Cycles
  await record('Cumulative milestone detection when 3 wallets buy at separate times', 'Threshold Alerting', () => {
    const group = createGroup('Cycle Test Group', 'Testing cycles', db);
    const w1 = '0xcc11111111111111111111111111111111111111';
    const w2 = '0xcc22222222222222222222222222222222222222';
    const w3 = '0xcc33333333333333333333333333333333333333';
    addWallet(w1, 'Buyer 1', 'evm', [group.id], db);
    addWallet(w2, 'Buyer 2', 'evm', [group.id], db);
    addWallet(w3, 'Buyer 3', 'evm', [group.id], db);

    const testSlug = 'cumulative-penguins';

    // Cycle 1: Wallet 1 buys
    recordProcessedEvent({
      eventId: 'cycle_ev_1',
      eventType: 'sale',
      chain: 'ethereum',
      collectionSlug: testSlug,
      walletAddress: w1,
      quantity: 1,
      timestamp: Date.now() - 60000,
    }, db);

    const alert1 = consolidator.consolidateEvents([
      {
        event_id: 'cycle_ev_1',
        event_type: 'sale',
        chain: 'ethereum',
        collection_slug: testSlug,
        collection_name: 'Cumulative Penguins',
        wallet_address: w1,
        quantity: 1,
        timestamp: Date.now() - 60000,
      }
    ], {}, { db, bypassThreshold: false });
    if (alert1.length !== 0) throw new Error('Expected 0 alerts for single wallet buy in Cycle 1');

    // Cycle 2: Wallet 2 buys 30 seconds later
    recordProcessedEvent({
      eventId: 'cycle_ev_2',
      eventType: 'sale',
      chain: 'ethereum',
      collectionSlug: testSlug,
      walletAddress: w2,
      quantity: 1,
      timestamp: Date.now() - 30000,
    }, db);

    const alert2 = consolidator.consolidateEvents([
      {
        event_id: 'cycle_ev_2',
        event_type: 'sale',
        chain: 'ethereum',
        collection_slug: testSlug,
        collection_name: 'Cumulative Penguins',
        wallet_address: w2,
        quantity: 1,
        timestamp: Date.now() - 30000,
      }
    ], {}, { db, bypassThreshold: false });
    if (alert2.length !== 0) throw new Error('Expected 0 alerts for 2 unique wallets in Cycle 2');

    // Cycle 3: Wallet 3 buys now
    recordProcessedEvent({
      eventId: 'cycle_ev_3',
      eventType: 'sale',
      chain: 'ethereum',
      collectionSlug: testSlug,
      walletAddress: w3,
      quantity: 2,
      timestamp: Date.now(),
    }, db);

    const alert3 = consolidator.consolidateEvents([
      {
        event_id: 'cycle_ev_3',
        event_type: 'sale',
        chain: 'ethereum',
        collection_slug: testSlug,
        collection_name: 'Cumulative Penguins',
        wallet_address: w3,
        quantity: 2,
        timestamp: Date.now(),
      }
    ], {}, { db, bypassThreshold: false });

    if (alert3.length !== 1) throw new Error(`Expected 1 alert in Cycle 3 when 3rd wallet buys, got ${alert3.length}`);
    if (alert3[0].totalUniqueWallets !== 3) throw new Error(`Expected totalUniqueWallets = 3, got ${alert3[0].totalUniqueWallets}`);
    if (alert3[0].milestone !== 3) throw new Error(`Expected milestone = 3, got ${alert3[0].milestone}`);
    if (!alert3[0].formattedMessage.includes('THRESHOLD REACHED: 3 UNIQUE WALLETS!')) throw new Error('Expected milestone badge in message');
  });

  // =========================================================================
  // OFFICIAL TEST SUITE (TESTS A THROUGH M — REQUIRED SPECIFICATION)
  // =========================================================================

  // TEST A — First milestone:
  // 2 unique wallets -> no alert; 3rd unique wallet -> exactly 1 alert
  await record('TEST A — First milestone: 2 wallets no alert, 3rd wallet triggers first alert', 'Official Milestones', () => {
    const slug = 'test-a-collection';
    const chain = 'ethereum';
    const grp = createGroup('Test A Grp', 'Grp for Test A', db);
    const w1 = '0xaa11111111111111111111111111111111111111';
    const w2 = '0xaa22222222222222222222222222222222222222';
    const w3 = '0xaa33333333333333333333333333333333333333';
    addWallet(w1, 'W1', 'evm', [grp.id], db);
    addWallet(w2, 'W2', 'evm', [grp.id], db);
    addWallet(w3, 'W3', 'evm', [grp.id], db);

    // 1st wallet mints
    const ev1 = { event_id: 'a_ev_1', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: w1, quantity: 1, timestamp: Date.now() - 5000 };
    recordProcessedEvent({ eventId: ev1.event_id, eventType: ev1.event_type, chain, collectionSlug: slug, walletAddress: w1, quantity: 1, timestamp: ev1.timestamp }, db);
    const a1 = consolidator.consolidateEvents([ev1], {}, { db, bypassThreshold: false });
    if (a1.length !== 0) throw new Error('Expected 0 alerts for 1 wallet');

    // 2nd wallet buys
    const ev2 = { event_id: 'a_ev_2', event_type: 'sale' as const, chain, collection_slug: slug, wallet_address: w2, quantity: 2, timestamp: Date.now() - 3000 };
    recordProcessedEvent({ eventId: ev2.event_id, eventType: ev2.event_type, chain, collectionSlug: slug, walletAddress: w2, quantity: 2, timestamp: ev2.timestamp }, db);
    const a2 = consolidator.consolidateEvents([ev2], {}, { db, bypassThreshold: false });
    if (a2.length !== 0) throw new Error('Expected 0 alerts for 2 wallets');

    // 3rd wallet mints -> immediately reaches 3 unique wallets -> exactly 1 alert
    const ev3 = { event_id: 'a_ev_3', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: w3, quantity: 1, timestamp: Date.now() };
    recordProcessedEvent({ eventId: ev3.event_id, eventType: ev3.event_type, chain, collectionSlug: slug, walletAddress: w3, quantity: 1, timestamp: ev3.timestamp }, db);
    const a3 = consolidator.consolidateEvents([ev3], {}, { db, bypassThreshold: false });
    if (a3.length !== 1) throw new Error(`Expected exactly 1 alert at 3 unique wallets, got ${a3.length}`);
    if (a3[0].milestone !== 3) throw new Error(`Expected milestone 3, got ${a3[0].milestone}`);
    if (a3[0].totalUniqueWallets !== 3) throw new Error(`Expected 3 total unique wallets, got ${a3[0].totalUniqueWallets}`);
    if (!a3[0].formattedMessage.includes('THRESHOLD REACHED: 3 UNIQUE WALLETS!')) throw new Error('Missing milestone 3 badge in alert message');
  });

  // TEST B — Second milestone:
  // Wallets 4 and 5 produce no alert; wallet 6 triggers exactly 1 alert
  await record('TEST B — Second milestone: Wallets 4 and 5 no alert, 6th wallet triggers second alert', 'Official Milestones', () => {
    const slug = 'test-b-collection';
    const chain = 'ethereum';
    const grp = createGroup('Test B Grp', 'Grp for Test B', db);
    const addrs = Array.from({ length: 6 }, (_, i) => `0xba${(i + 1).toString().padStart(38, '0')}`);
    addrs.forEach((addr, i) => addWallet(addr, `B_W${i + 1}`, 'evm', [grp.id], db));

    // First 3 wallets reach milestone 3
    for (let i = 0; i < 3; i++) {
      const ev = { event_id: `b_ev_${i + 1}`, event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: addrs[i], quantity: 1, timestamp: Date.now() - (10 - i) * 1000 };
      recordProcessedEvent({ eventId: ev.event_id, eventType: ev.event_type, chain, collectionSlug: slug, walletAddress: addrs[i], quantity: 1, timestamp: ev.timestamp }, db);
      consolidator.consolidateEvents([ev], {}, { db, bypassThreshold: false });
    }

    // Wallets 4 & 5 qualify -> should NOT produce alert
    for (let i = 3; i < 5; i++) {
      const ev = { event_id: `b_ev_${i + 1}`, event_type: 'sale' as const, chain, collection_slug: slug, wallet_address: addrs[i], quantity: 1, timestamp: Date.now() - (5 - i) * 1000 };
      recordProcessedEvent({ eventId: ev.event_id, eventType: ev.event_type, chain, collectionSlug: slug, walletAddress: addrs[i], quantity: 1, timestamp: ev.timestamp }, db);
      const res = consolidator.consolidateEvents([ev], {}, { db, bypassThreshold: false });
      if (res.length !== 0) throw new Error(`Expected 0 alerts for wallet ${i + 1}, got ${res.length}`);
    }

    // Wallet 6 qualifies -> triggers 2nd alert (milestone 6)
    const ev6 = { event_id: 'b_ev_6', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: addrs[5], quantity: 1, timestamp: Date.now() };
    recordProcessedEvent({ eventId: ev6.event_id, eventType: ev6.event_type, chain, collectionSlug: slug, walletAddress: addrs[5], quantity: 1, timestamp: ev6.timestamp }, db);
    const a6 = consolidator.consolidateEvents([ev6], {}, { db, bypassThreshold: false });
    if (a6.length !== 1) throw new Error(`Expected exactly 1 alert at 6 unique wallets, got ${a6.length}`);
    if (a6[0].milestone !== 6) throw new Error(`Expected milestone 6, got ${a6[0].milestone}`);
    if (a6[0].totalUniqueWallets !== 6) throw new Error(`Expected 6 unique wallets, got ${a6[0].totalUniqueWallets}`);
    if (!a6[0].formattedMessage.includes('6 UNIQUE WALLETS!')) throw new Error('Missing milestone 6 badge');
  });

  // TEST C — Third milestone:
  // Wallets 7-9 produce no alert; wallet 10 triggers exactly 1 alert
  await record('TEST C — Third milestone: Wallets 7-9 no alert, 10th wallet triggers third alert', 'Official Milestones', () => {
    const slug = 'test-c-collection';
    const chain = 'ethereum';
    const grp = createGroup('Test C Grp', '', db);
    const addrs = Array.from({ length: 10 }, (_, i) => `0xca${(i + 1).toString().padStart(38, '0')}`);
    addrs.forEach((addr, i) => addWallet(addr, `C_W${i + 1}`, 'evm', [grp.id], db));

    // Wallets 1-6
    for (let i = 0; i < 6; i++) {
      const ev = { event_id: `c_ev_${i + 1}`, event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: addrs[i], quantity: 1, timestamp: Date.now() - (20 - i) * 1000 };
      recordProcessedEvent({ eventId: ev.event_id, eventType: ev.event_type, chain, collectionSlug: slug, walletAddress: addrs[i], quantity: 1, timestamp: ev.timestamp }, db);
      consolidator.consolidateEvents([ev], {}, { db, bypassThreshold: false });
    }

    // Wallets 7, 8, 9 -> no alert
    for (let i = 6; i < 9; i++) {
      const ev = { event_id: `c_ev_${i + 1}`, event_type: 'sale' as const, chain, collection_slug: slug, wallet_address: addrs[i], quantity: 1, timestamp: Date.now() - (10 - i) * 1000 };
      recordProcessedEvent({ eventId: ev.event_id, eventType: ev.event_type, chain, collectionSlug: slug, walletAddress: addrs[i], quantity: 1, timestamp: ev.timestamp }, db);
      const res = consolidator.consolidateEvents([ev], {}, { db, bypassThreshold: false });
      if (res.length !== 0) throw new Error(`Expected 0 alerts for wallet ${i + 1}, got ${res.length}`);
    }

    // Wallet 10 -> milestone 10 alert
    const ev10 = { event_id: 'c_ev_10', event_type: 'sale' as const, chain, collection_slug: slug, wallet_address: addrs[9], quantity: 1, timestamp: Date.now() };
    recordProcessedEvent({ eventId: ev10.event_id, eventType: ev10.event_type, chain, collectionSlug: slug, walletAddress: addrs[9], quantity: 1, timestamp: ev10.timestamp }, db);
    const a10 = consolidator.consolidateEvents([ev10], {}, { db, bypassThreshold: false });
    if (a10.length !== 1) throw new Error(`Expected exactly 1 alert at 10 wallets, got ${a10.length}`);
    if (a10[0].milestone !== 10) throw new Error(`Expected milestone 10, got ${a10[0].milestone}`);
    if (a10[0].totalUniqueWallets !== 10) throw new Error(`Expected 10 total wallets, got ${a10[0].totalUniqueWallets}`);
    if (!a10[0].formattedMessage.includes('10 UNIQUE WALLETS!')) throw new Error('Missing milestone 10 badge');
  });

  // TEST D — Fourth milestone:
  // Wallets 11-14 produce no alert; wallet 15 triggers exactly 1 alert
  await record('TEST D — Fourth milestone: Wallets 11-14 no alert, 15th wallet triggers fourth alert', 'Official Milestones', () => {
    const slug = 'test-d-collection';
    const chain = 'ethereum';
    const grp = createGroup('Test D Grp', '', db);
    const addrs = Array.from({ length: 15 }, (_, i) => `0xda${(i + 1).toString().padStart(38, '0')}`);
    addrs.forEach((addr, i) => addWallet(addr, `D_W${i + 1}`, 'evm', [grp.id], db));

    // Wallets 1-10
    for (let i = 0; i < 10; i++) {
      const ev = { event_id: `d_ev_${i + 1}`, event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: addrs[i], quantity: 1, timestamp: Date.now() - (30 - i) * 1000 };
      recordProcessedEvent({ eventId: ev.event_id, eventType: ev.event_type, chain, collectionSlug: slug, walletAddress: addrs[i], quantity: 1, timestamp: ev.timestamp }, db);
      consolidator.consolidateEvents([ev], {}, { db, bypassThreshold: false });
    }

    // Wallets 11-14 -> no alert
    for (let i = 10; i < 14; i++) {
      const ev = { event_id: `d_ev_${i + 1}`, event_type: 'sale' as const, chain, collection_slug: slug, wallet_address: addrs[i], quantity: 1, timestamp: Date.now() - (15 - i) * 1000 };
      recordProcessedEvent({ eventId: ev.event_id, eventType: ev.event_type, chain, collectionSlug: slug, walletAddress: addrs[i], quantity: 1, timestamp: ev.timestamp }, db);
      const res = consolidator.consolidateEvents([ev], {}, { db, bypassThreshold: false });
      if (res.length !== 0) throw new Error(`Expected 0 alerts for wallet ${i + 1}`);
    }

    // Wallet 15 -> milestone 15 alert
    const ev15 = { event_id: 'd_ev_15', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: addrs[14], quantity: 1, timestamp: Date.now() };
    recordProcessedEvent({ eventId: ev15.event_id, eventType: ev15.event_type, chain, collectionSlug: slug, walletAddress: addrs[14], quantity: 1, timestamp: ev15.timestamp }, db);
    const a15 = consolidator.consolidateEvents([ev15], {}, { db, bypassThreshold: false });
    if (a15.length !== 1) throw new Error(`Expected exactly 1 alert at 15 wallets, got ${a15.length}`);
    if (a15[0].milestone !== 15) throw new Error(`Expected milestone 15, got ${a15[0].milestone}`);
    if (a15[0].totalUniqueWallets !== 15) throw new Error(`Expected 15 unique wallets, got ${a15[0].totalUniqueWallets}`);
    if (!a15[0].formattedMessage.includes('15 UNIQUE WALLETS!')) throw new Error('Missing milestone 15 badge');
  });

  // TEST E — Multiple groups:
  // 1 wallet from Group A, 1 from Group B, 1 from Group C -> combined 3 unique wallets triggers first alert
  await record('TEST E — Multiple groups: 1 from Group A, 1 from B, 1 from C combine to trigger first alert', 'Multi-Group Monitoring', () => {
    const slug = 'test-e-collection';
    const chain = 'ethereum';
    const grpA = createGroup('Group A Alpha', '', db);
    const grpB = createGroup('Group B Beta', '', db);
    const grpC = createGroup('Group C Gamma', '', db);

    const wA = '0xea11111111111111111111111111111111111111';
    const wB = '0xeb22222222222222222222222222222222222222';
    const wC = '0xec33333333333333333333333333333333333333';

    addWallet(wA, 'From Grp A', 'evm', [grpA.id], db);
    addWallet(wB, 'From Grp B', 'evm', [grpB.id], db);
    addWallet(wC, 'From Grp C', 'evm', [grpC.id], db);

    // Wallet from Grp A mints -> 1 wallet, no alert
    const evA = { event_id: 'e_ev_1', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: wA, quantity: 1, timestamp: Date.now() - 5000 };
    recordProcessedEvent({ eventId: evA.event_id, eventType: evA.event_type, chain, collectionSlug: slug, walletAddress: wA, quantity: 1, timestamp: evA.timestamp }, db);
    const resA = consolidator.consolidateEvents([evA], {}, { db, bypassThreshold: false });
    if (resA.length !== 0) throw new Error('Expected 0 alerts for first group wallet');

    // Wallet from Grp B buys -> 2 wallets, no alert
    const evB = { event_id: 'e_ev_2', event_type: 'sale' as const, chain, collection_slug: slug, wallet_address: wB, quantity: 1, timestamp: Date.now() - 3000 };
    recordProcessedEvent({ eventId: evB.event_id, eventType: evB.event_type, chain, collectionSlug: slug, walletAddress: wB, quantity: 1, timestamp: evB.timestamp }, db);
    const resB = consolidator.consolidateEvents([evB], {}, { db, bypassThreshold: false });
    if (resB.length !== 0) throw new Error('Expected 0 alerts for second group wallet');

    // Wallet from Grp C mints -> total 3 unique wallets across 3 distinct groups -> exactly 1 alert
    const evC = { event_id: 'e_ev_3', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: wC, quantity: 1, timestamp: Date.now() };
    recordProcessedEvent({ eventId: evC.event_id, eventType: evC.event_type, chain, collectionSlug: slug, walletAddress: wC, quantity: 1, timestamp: evC.timestamp }, db);
    const resC = consolidator.consolidateEvents([evC], {}, { db, bypassThreshold: false });
    if (resC.length !== 1) throw new Error(`Expected 1 alert from combined groups, got ${resC.length}`);
    if (resC[0].totalUniqueWallets !== 3) throw new Error(`Expected totalUniqueWallets = 3, got ${resC[0].totalUniqueWallets}`);
    if (resC[0].groups.length !== 3) throw new Error(`Expected 3 group summaries, got ${resC[0].groups.length}`);
  });

  // TEST F — Duplicate wallet:
  // Same wallet mints & buys multiple times -> counts only once
  await record('TEST F — Duplicate wallet: Multiple mints and buys from same wallet count only once', 'Deduplication', () => {
    const slug = 'test-f-collection';
    const chain = 'ethereum';
    const grpF = createGroup('Test F Grp', '', db);
    const w1 = '0xfa11111111111111111111111111111111111111';
    const w2 = '0xfa22222222222222222222222222222222222222';
    addWallet(w1, 'F1', 'evm', [grpF.id], db);
    addWallet(w2, 'F2', 'evm', [grpF.id], db);

    // Wallet 1 mints
    const ev1 = { event_id: 'f_ev_1', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: w1, quantity: 2, timestamp: Date.now() - 5000 };
    recordProcessedEvent({ eventId: ev1.event_id, eventType: ev1.event_type, chain, collectionSlug: slug, walletAddress: w1, quantity: 2, timestamp: ev1.timestamp }, db);

    // Wallet 1 buys in the same collection
    const ev2 = { event_id: 'f_ev_2', event_type: 'sale' as const, chain, collection_slug: slug, wallet_address: w1, quantity: 1, timestamp: Date.now() - 4000 };
    recordProcessedEvent({ eventId: ev2.event_id, eventType: ev2.event_type, chain, collectionSlug: slug, walletAddress: w1, quantity: 1, timestamp: ev2.timestamp }, db);

    // Wallet 1 mints again in another tx
    const ev3 = { event_id: 'f_ev_3', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: w1, quantity: 3, timestamp: Date.now() - 3000 };
    recordProcessedEvent({ eventId: ev3.event_id, eventType: ev3.event_type, chain, collectionSlug: slug, walletAddress: w1, quantity: 3, timestamp: ev3.timestamp }, db);

    const a1 = consolidator.consolidateEvents([ev3], {}, { db, bypassThreshold: false });
    if (a1.length !== 0) throw new Error('Wallet 1 performed 3 actions but should only count as 1 unique wallet (no alert)');

    // Wallet 2 buys
    const ev4 = { event_id: 'f_ev_4', event_type: 'sale' as const, chain, collection_slug: slug, wallet_address: w2, quantity: 1, timestamp: Date.now() - 2000 };
    recordProcessedEvent({ eventId: ev4.event_id, eventType: ev4.event_type, chain, collectionSlug: slug, walletAddress: w2, quantity: 1, timestamp: ev4.timestamp }, db);

    // Wallet 2 buys again
    const ev5 = { event_id: 'f_ev_5', event_type: 'sale' as const, chain, collection_slug: slug, wallet_address: w2, quantity: 4, timestamp: Date.now() };
    recordProcessedEvent({ eventId: ev5.event_id, eventType: ev5.event_type, chain, collectionSlug: slug, walletAddress: w2, quantity: 4, timestamp: ev5.timestamp }, db);

    const a2 = consolidator.consolidateEvents([ev5], {}, { db, bypassThreshold: false });
    if (a2.length !== 0) throw new Error('Total unique wallets is 2 (W1 and W2), should not alert');
  });

  // TEST G — Mixed activities:
  // 2 mints + 1 buy -> reaches 3 unique wallets -> alert fires
  await record('TEST G — Mixed activities: 2 mints + 1 buy reaches 3 unique wallets and fires alert', 'Activity Detection', () => {
    const slug = 'test-g-collection';
    const chain = 'ethereum';
    const grp = createGroup('Test G Grp', '', db);
    const w1 = '0xga11111111111111111111111111111111111111';
    const w2 = '0xga22222222222222222222222222222222222222';
    const w3 = '0xga33333333333333333333333333333333333333';
    addWallet(w1, 'G1', 'evm', [grp.id], db);
    addWallet(w2, 'G2', 'evm', [grp.id], db);
    addWallet(w3, 'G3', 'evm', [grp.id], db);

    const ev1 = { event_id: 'g_ev_1', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: w1, quantity: 1, timestamp: Date.now() - 5000 };
    const ev2 = { event_id: 'g_ev_2', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: w2, quantity: 1, timestamp: Date.now() - 3000 };
    const ev3 = { event_id: 'g_ev_3', event_type: 'sale' as const, chain, collection_slug: slug, wallet_address: w3, quantity: 1, timestamp: Date.now() };

    recordProcessedEvent({ eventId: ev1.event_id, eventType: ev1.event_type, chain, collectionSlug: slug, walletAddress: w1, quantity: 1, timestamp: ev1.timestamp }, db);
    recordProcessedEvent({ eventId: ev2.event_id, eventType: ev2.event_type, chain, collectionSlug: slug, walletAddress: w2, quantity: 1, timestamp: ev2.timestamp }, db);
    recordProcessedEvent({ eventId: ev3.event_id, eventType: ev3.event_type, chain, collectionSlug: slug, walletAddress: w3, quantity: 1, timestamp: ev3.timestamp }, db);

    const alerts = consolidator.consolidateEvents([ev3], {}, { db, bypassThreshold: false });
    if (alerts.length !== 1) throw new Error(`Expected 1 alert for 2 mints + 1 buy, got ${alerts.length}`);
    if (alerts[0].totalUniqueWallets !== 3) throw new Error(`Expected 3 unique wallets, got ${alerts[0].totalUniqueWallets}`);
    if (alerts[0].alertType !== 'both') throw new Error(`Expected alertType to be 'both', got ${alerts[0].alertType}`);
    if (!alerts[0].formattedMessage.includes('SMART MONEY MINT & BUY') && !alerts[0].formattedMessage.includes('SMART MONEY')) {
      throw new Error('Message header did not reflect mixed activities');
    }
  });

  // TEST H — Multiple collections:
  // Activity on Collection A does not bleed into Collection B
  await record('TEST H — Multiple collections: Counts for different collections remain completely independent', 'Collection Isolation', () => {
    const slugA = 'col-alpha';
    const slugB = 'col-beta';
    const chain = 'ethereum';
    const grp = createGroup('Test H Grp', '', db);
    const w1 = '0xha11111111111111111111111111111111111111';
    const w2 = '0xha22222222222222222222222222222222222222';
    const w3 = '0xha33333333333333333333333333333333333333';
    addWallet(w1, 'H1', 'evm', [grp.id], db);
    addWallet(w2, 'H2', 'evm', [grp.id], db);
    addWallet(w3, 'H3', 'evm', [grp.id], db);

    // 2 wallets mint Col A
    const evA1 = { event_id: 'h_a_1', event_type: 'mint' as const, chain, collection_slug: slugA, wallet_address: w1, quantity: 1, timestamp: Date.now() - 4000 };
    const evA2 = { event_id: 'h_a_2', event_type: 'mint' as const, chain, collection_slug: slugA, wallet_address: w2, quantity: 1, timestamp: Date.now() - 3000 };
    recordProcessedEvent({ eventId: evA1.event_id, eventType: evA1.event_type, chain, collectionSlug: slugA, walletAddress: w1, quantity: 1, timestamp: evA1.timestamp }, db);
    recordProcessedEvent({ eventId: evA2.event_id, eventType: evA2.event_type, chain, collectionSlug: slugA, walletAddress: w2, quantity: 1, timestamp: evA2.timestamp }, db);

    // 2 wallets mint Col B
    const evB1 = { event_id: 'h_b_1', event_type: 'mint' as const, chain, collection_slug: slugB, wallet_address: w1, quantity: 1, timestamp: Date.now() - 2000 };
    const evB2 = { event_id: 'h_b_2', event_type: 'mint' as const, chain, collection_slug: slugB, wallet_address: w2, quantity: 1, timestamp: Date.now() - 1000 };
    recordProcessedEvent({ eventId: evB1.event_id, eventType: evB1.event_type, chain, collectionSlug: slugB, walletAddress: w1, quantity: 1, timestamp: evB1.timestamp }, db);
    recordProcessedEvent({ eventId: evB2.event_id, eventType: evB2.event_type, chain, collectionSlug: slugB, walletAddress: w2, quantity: 1, timestamp: evB2.timestamp }, db);

    const aA_pre = consolidator.consolidateEvents([evA2], {}, { db, bypassThreshold: false });
    const aB_pre = consolidator.consolidateEvents([evB2], {}, { db, bypassThreshold: false });
    if (aA_pre.length !== 0 || aB_pre.length !== 0) throw new Error('Neither collection reached 3 wallets yet');

    // 3rd wallet mints Col A -> ONLY Col A alerts
    const evA3 = { event_id: 'h_a_3', event_type: 'mint' as const, chain, collection_slug: slugA, wallet_address: w3, quantity: 1, timestamp: Date.now() };
    recordProcessedEvent({ eventId: evA3.event_id, eventType: evA3.event_type, chain, collectionSlug: slugA, walletAddress: w3, quantity: 1, timestamp: evA3.timestamp }, db);
    const aA_post = consolidator.consolidateEvents([evA3], {}, { db, bypassThreshold: false });
    if (aA_post.length !== 1) throw new Error(`Expected 1 alert for Col A, got ${aA_post.length}`);
    if (aA_post[0].collectionSlug !== slugA) throw new Error(`Expected alert for Col A, got ${aA_post[0].collectionSlug}`);

    // Col B should still have no alert
    const checkB = getAchievedMilestones(slugB, chain, 'all', 2, db);
    if (checkB.eligibleMilestones.length !== 0) throw new Error('Col B should have 0 achieved milestones');
  });

  // TEST I — Restart:
  // 2 wallets qualify -> restart bot -> 3rd qualifies -> alert fires
  await record('TEST I — Restart: Progress is preserved across bot restart; 3rd wallet triggers alert', 'Restart Persistence', () => {
    const slug = 'test-i-collection';
    const chain = 'ethereum';
    const grp = createGroup('Test I Grp', '', db);
    const w1 = '0x1a11111111111111111111111111111111111111';
    const w2 = '0x1a22222222222222222222222222222222222222';
    const w3 = '0x1a33333333333333333333333333333333333333';
    addWallet(w1, 'I1', 'evm', [grp.id], db);
    addWallet(w2, 'I2', 'evm', [grp.id], db);
    addWallet(w3, 'I3', 'evm', [grp.id], db);

    // 2 wallets qualify
    const ev1 = { event_id: 'i_ev_1', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: w1, quantity: 1, timestamp: Date.now() - 5000 };
    const ev2 = { event_id: 'i_ev_2', event_type: 'sale' as const, chain, collection_slug: slug, wallet_address: w2, quantity: 1, timestamp: Date.now() - 3000 };
    recordProcessedEvent({ eventId: ev1.event_id, eventType: ev1.event_type, chain, collectionSlug: slug, walletAddress: w1, quantity: 1, timestamp: ev1.timestamp }, db);
    recordProcessedEvent({ eventId: ev2.event_id, eventType: ev2.event_type, chain, collectionSlug: slug, walletAddress: w2, quantity: 1, timestamp: ev2.timestamp }, db);

    // Simulate complete process restart (closing db instance and re-opening from disk)
    closeDatabase();
    const restartedDb = initDatabase(testDbPath);

    // 3rd wallet qualifies after restart
    const ev3 = { event_id: 'i_ev_3', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: w3, quantity: 1, timestamp: Date.now() };
    recordProcessedEvent({ eventId: ev3.event_id, eventType: ev3.event_type, chain, collectionSlug: slug, walletAddress: w3, quantity: 1, timestamp: ev3.timestamp }, restartedDb);

    const freshConsolidator = new AlertConsolidator();
    const alerts = freshConsolidator.consolidateEvents([ev3], {}, { db: restartedDb, bypassThreshold: false });
    if (alerts.length !== 1) throw new Error(`Expected 1 alert after restart, got ${alerts.length}`);
    if (alerts[0].totalUniqueWallets !== 3) throw new Error(`Expected 3 total unique wallets after restart, got ${alerts[0].totalUniqueWallets}`);
    if (alerts[0].milestone !== 3) throw new Error(`Expected milestone 3, got ${alerts[0].milestone}`);
  });

  // TEST J — Duplicate polling:
  // Same event polled repeatedly does not inflate count or re-alert
  await record('TEST J — Duplicate polling: Repeatedly polled events do not inflate count or re-alert', 'Deduplication', () => {
    const slug = 'test-j-collection';
    const chain = 'ethereum';
    const grp = createGroup('Test J Grp', '', db);
    const w1 = '0xja11111111111111111111111111111111111111';
    const w2 = '0xja22222222222222222222222222222222222222';
    const w3 = '0xja33333333333333333333333333333333333333';
    addWallet(w1, 'J1', 'evm', [grp.id], db);
    addWallet(w2, 'J2', 'evm', [grp.id], db);
    addWallet(w3, 'J3', 'evm', [grp.id], db);

    const ev1 = { event_id: 'j_ev_1', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: w1, quantity: 1, timestamp: Date.now() - 5000 };
    const ev2 = { event_id: 'j_ev_2', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: w2, quantity: 1, timestamp: Date.now() - 4000 };
    const ev3 = { event_id: 'j_ev_3', event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: w3, quantity: 1, timestamp: Date.now() - 3000 };

    // Record initial events
    recordProcessedEvent({ eventId: ev1.event_id, eventType: ev1.event_type, chain, collectionSlug: slug, walletAddress: w1, quantity: 1, timestamp: ev1.timestamp }, db);
    recordProcessedEvent({ eventId: ev2.event_id, eventType: ev2.event_type, chain, collectionSlug: slug, walletAddress: w2, quantity: 1, timestamp: ev2.timestamp }, db);
    recordProcessedEvent({ eventId: ev3.event_id, eventType: ev3.event_type, chain, collectionSlug: slug, walletAddress: w3, quantity: 1, timestamp: ev3.timestamp }, db);

    // Initial alert fired
    const firstAlerts = consolidator.consolidateEvents([ev3], {}, { db, bypassThreshold: false });
    if (firstAlerts.length !== 1) throw new Error('Expected first alert at milestone 3');

    // Poll 2: Exact same events returned again from API
    // Check if marked processed
    if (!isEventProcessed('j_ev_1', db)) throw new Error('Event 1 should be marked processed');
    if (!isEventProcessed('j_ev_2', db)) throw new Error('Event 2 should be marked processed');
    if (!isEventProcessed('j_ev_3', db)) throw new Error('Event 3 should be marked processed');

    // Trying to consolidate same events again
    const secondAlerts = consolidator.consolidateEvents([ev1, ev2, ev3], {}, { db, bypassThreshold: false });
    if (secondAlerts.length !== 0) throw new Error('Duplicate poll triggered redundant alert!');
  });

  // TEST K — Simultaneous events:
  // Multiple events arriving close together produce exactly one alert per reached milestone
  await record('TEST K — Simultaneous events: Batch of multiple events produces exactly one alert per reached milestone', 'Batch Processing', () => {
    const slug = 'test-k-collection';
    const chain = 'ethereum';
    const grp = createGroup('Test K Grp', '', db);
    const addrs = Array.from({ length: 5 }, (_, i) => `0xka${(i + 1).toString().padStart(38, '0')}`);
    addrs.forEach((addr, i) => addWallet(addr, `K_W${i + 1}`, 'evm', [grp.id], db));

    // 5 events arriving simultaneously in one poll
    const simultaneousBatch = addrs.map((addr, i) => ({
      event_id: `k_batch_ev_${i + 1}`,
      event_type: 'mint' as const,
      chain,
      collection_slug: slug,
      wallet_address: addr,
      quantity: 1,
      timestamp: Date.now(),
    }));

    simultaneousBatch.forEach((ev) => {
      recordProcessedEvent({ eventId: ev.event_id, eventType: ev.event_type, chain, collectionSlug: slug, walletAddress: ev.wallet_address, quantity: 1, timestamp: ev.timestamp }, db);
    });

    const alerts = consolidator.consolidateEvents(simultaneousBatch, {}, { db, bypassThreshold: false });
    if (alerts.length !== 1) throw new Error(`Expected exactly 1 alert for milestone 3 (5 wallets < 6), got ${alerts.length}`);
    if (alerts[0].milestone !== 3) throw new Error(`Expected milestone 3, got ${alerts[0].milestone}`);
    if (alerts[0].totalUniqueWallets !== 5) throw new Error(`Expected 5 unique wallets, got ${alerts[0].totalUniqueWallets}`);
  });

  // TEST L — API failure:
  // OpenSea rate limit/network error is safely handled without crash or invalid DB state
  await record('TEST L — API failure: Rate limit and network errors handled safely with zero state corruption', 'Error Handling', async () => {
    const mockFailingService = new OpenSeaService('bad_mock_key');
    // Test getAccountEvents with error scenario
    const res = await mockFailingService.getAccountEvents('0x0000000000000000000000000000000000000000', {
      afterTimestamp: Date.now() - 60000,
    });
    if (!res || !Array.isArray(res.events)) {
      throw new Error('API failure should return safe empty events structure, not crash');
    }
  });

  // TEST M — Beyond final milestone:
  // 16+ wallets do not trigger additional milestone alerts in same cycle
  await record('TEST M — Beyond final milestone: Wallets 16+ do not trigger extra alerts in same cycle', 'Threshold Alerting', () => {
    const slug = 'test-m-collection';
    const chain = 'ethereum';
    const grp = createGroup('Test M Grp', '', db);
    const addrs = Array.from({ length: 18 }, (_, i) => `0xma${(i + 1).toString().padStart(38, '0')}`);
    addrs.forEach((addr, i) => addWallet(addr, `M_W${i + 1}`, 'evm', [grp.id], db));

    // Feed first 15 wallets and achieve all 4 milestones (3, 6, 10, 15)
    for (let i = 0; i < 15; i++) {
      const ev = { event_id: `m_ev_${i + 1}`, event_type: 'mint' as const, chain, collection_slug: slug, wallet_address: addrs[i], quantity: 1, timestamp: Date.now() - (30 - i) * 1000 };
      recordProcessedEvent({ eventId: ev.event_id, eventType: ev.event_type, chain, collectionSlug: slug, walletAddress: addrs[i], quantity: 1, timestamp: ev.timestamp }, db);
      consolidator.consolidateEvents([ev], {}, { db, bypassThreshold: false });
    }

    // Wallets 16, 17, 18 qualify
    for (let i = 15; i < 18; i++) {
      const ev = { event_id: `m_ev_${i + 1}`, event_type: 'sale' as const, chain, collection_slug: slug, wallet_address: addrs[i], quantity: 1, timestamp: Date.now() };
      recordProcessedEvent({ eventId: ev.event_id, eventType: ev.event_type, chain, collectionSlug: slug, walletAddress: addrs[i], quantity: 1, timestamp: ev.timestamp }, db);
      const res = consolidator.consolidateEvents([ev], {}, { db, bypassThreshold: false });
      if (res.length !== 0) throw new Error(`Wallet ${i + 1} triggered an unexpected alert beyond the 15 milestone: ${JSON.stringify(res)}`);
    }

    // Verify all 4 milestones were achieved
    const check18 = getAchievedMilestones(slug, chain, 'all', 18, db);
    if (check18.eligibleMilestones.length !== 0) {
      throw new Error('All 4 milestones should already be notified, none eligible');
    }
  });

  // Clean up test db files
  closeDatabase();
  for (const f of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      // ignore
    }
  }

  // Restore main DB
  initDatabase();

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;

  return { results, summary: { total, passed, failed } };
}

// If run directly from CLI
if (process.argv[1]?.includes('run_all_tests')) {
  runAllTests().then(({ results, summary }) => {
    console.log(`\n======================================================`);
    console.log(`TEST SUITE RESULTS: ${summary.passed}/${summary.total} PASSED`);
    console.log(`======================================================\n`);
    results.forEach((r, idx) => {
      const icon = r.passed ? '✅' : '❌';
      console.log(`${icon} [${r.category}] ${r.title} (${r.durationMs}ms)`);
      if (!r.passed) {
        console.error(`   Error: ${r.message}`);
      }
    });
    console.log(`\nSummary: ${summary.passed} passed, ${summary.failed} failed\n`);
    if (summary.failed > 0) process.exit(1);
  });
}
