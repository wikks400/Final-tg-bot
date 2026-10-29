import {
  NFTEvent,
  ConsolidatedAlert,
  ConsolidatedGroupSummary,
  CollectionMetadata,
} from '../../types.ts';
import {
  getAllGroups,
  getAllWallets,
  initDatabase,
  getAchievedMilestones,
  recordMilestoneAlerted,
  getRecentProcessedEventsForCollection,
  getMilestoneThresholds,
  getMonitoringWindowHours,
  getSystemSettings,
} from '../database/db.ts';

export class AlertConsolidator {
  /**
   * Consolidates qualifying events by collection and blockchain network
   * across all configured and enabled groups into clean, deduplicated alert payloads.
   *
   * Enforces 4 alert milestones:
   * - 3 unique wallets: First alert
   * - 6 unique wallets: Second alert
   * - 10 unique wallets: Third alert
   * - 15 unique wallets: Fourth alert
   *
   * Both NFT minting and NFT purchasing contribute to the same unique wallet count.
   * A wallet that mints and subsequently buys counts only once for that collection.
   */
  public consolidateEvents(
    events: NFTEvent[],
    collectionMetadataMap: Record<string, CollectionMetadata> = {},
    optionsOrDb: any = {}
  ): ConsolidatedAlert[] {
    if (!events || events.length === 0) return [];

    const isDb = Boolean(optionsOrDb && typeof optionsOrDb.prepare === 'function');
    const options = isDb ? { db: optionsOrDb } : optionsOrDb;
    const db = options.db || initDatabase();
    const bypassThreshold = Boolean(options.bypassThreshold);
    const isSimulation = Boolean(options.isSimulation);

    const settings = getSystemSettings(db);
    if (!settings.milestoneAlertsEnabled && !bypassThreshold) {
      return [];
    }

    const allGroups = getAllGroups(db);
    const allWallets = getAllWallets(db);

    // Only monitor configured groups that are enabled (is_enabled === 1)
    const enabledGroups = allGroups.filter((g) => g.is_enabled === 1);
    const enabledGroupIds = new Set(enabledGroups.map((g) => g.id));

    // Map wallet address -> list of enabled groups it belongs to
    const walletToGroupMap: Record<string, { id: string; name: string }[]> = {};
    for (const w of allWallets) {
      const lower = w.address.toLowerCase();
      const groupsForWallet = enabledGroups.filter((g) => w.groups?.includes(g.id));
      walletToGroupMap[lower] = groupsForWallet.map((g) => ({ id: g.id, name: g.name }));
    }

    // Cluster events by collection and chain: `${chain}:${collection_slug}`
    // Both mints and purchases contribute to the same collection counter
    const clusters: Record<string, NFTEvent[]> = {};
    for (const ev of events) {
      // Respect settings for mint and purchase detection
      if (ev.event_type === 'mint' && !settings.mintDetectionEnabled) continue;
      if (ev.event_type === 'sale' && !settings.purchaseDetectionEnabled) continue;

      const key = `${ev.chain.toLowerCase()}:${ev.collection_slug.toLowerCase()}`;
      if (!clusters[key]) {
        clusters[key] = [];
      }
      clusters[key].push(ev);
    }

    const consolidatedAlerts: ConsolidatedAlert[] = [];

    for (const [, clusterEvents] of Object.entries(clusters)) {
      const firstEvent = clusterEvents[0];
      const chain = firstEvent.chain;
      const collectionSlug = firstEvent.collection_slug;

      const meta = collectionMetadataMap[collectionSlug] || {
        slug: collectionSlug,
        name: firstEvent.collection_name || collectionSlug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        chain,
        opensea_url: `https://opensea.io/collection/${collectionSlug}`,
        updated_at: Date.now(),
      };

      // Combine events in this cycle with recent processed events from database within the monitoring window
      // so wallets that bought/minted at different times contribute toward the cumulative 3, 6, 10, 15 milestones
      const combinedEventsMap = new Map<
        string,
        {
          wallet_address: string;
          quantity: number;
          event_id: string;
          event_type: 'mint' | 'sale';
          tx_hash?: string;
        }
      >();

      if (!isSimulation) {
        const windowHours = settings.monitoringWindowHours;
        const windowMs = windowHours > 0 ? windowHours * 3600000 : 0;
        const historical = getRecentProcessedEventsForCollection(
          collectionSlug,
          chain,
          'all',
          windowMs,
          db
        );
        for (const h of historical) {
          if (h.event_type === 'mint' && !settings.mintDetectionEnabled) continue;
          if (h.event_type === 'sale' && !settings.purchaseDetectionEnabled) continue;

          combinedEventsMap.set(h.event_id, {
            wallet_address: h.wallet_address.toLowerCase(),
            quantity: h.quantity,
            event_id: h.event_id,
            event_type: h.event_type,
            tx_hash: h.tx_hash,
          });
        }
      }

      for (const ev of clusterEvents) {
        combinedEventsMap.set(ev.event_id, {
          wallet_address: ev.wallet_address.toLowerCase(),
          quantity: ev.quantity,
          event_id: ev.event_id,
          event_type: ev.event_type === 'mint' ? 'mint' : 'sale',
          tx_hash: ev.tx_hash,
        });
      }

      const allEventsForCollection = Array.from(combinedEventsMap.values());

      // 1. Group-level calculation (only enabled groups):
      const groupParticipation: Record<
        string,
        {
          name: string;
          uniqueWallets: Set<string>;
          nftsCount: number;
        }
      > = {};

      for (const ev of allEventsForCollection) {
        const walletLower = ev.wallet_address.toLowerCase();
        const memberGroups = walletToGroupMap[walletLower] || [];

        for (const grp of memberGroups) {
          if (!enabledGroupIds.has(grp.id)) continue;

          if (!groupParticipation[grp.id]) {
            groupParticipation[grp.id] = {
              name: grp.name,
              uniqueWallets: new Set(),
              nftsCount: 0,
            };
          }
          groupParticipation[grp.id].uniqueWallets.add(walletLower);
          groupParticipation[grp.id].nftsCount += ev.quantity;
        }
      }

      // Convert to summary array
      const groupSummaries: ConsolidatedGroupSummary[] = Object.entries(groupParticipation)
        .map(([gId, p]) => ({
          groupId: gId,
          groupName: p.name,
          uniqueCount: p.uniqueWallets.size,
          nftsCount: p.nftsCount,
        }))
        .filter((g) => g.uniqueCount > 0);

      // If no tracked enabled group members participated, skip alert
      if (groupSummaries.length === 0) {
        continue;
      }

      // 2. Accurate Overall Deduplication:
      // Every wallet is counted ONCE per collection, even if it minted, bought, or belongs to multiple groups
      const allDistinctWallets = new Set<string>();
      for (const p of Object.values(groupParticipation)) {
        for (const w of p.uniqueWallets) {
          allDistinctWallets.add(w);
        }
      }
      const totalUniqueWallets = allDistinctWallets.size;

      // 3. Activity classification (Mint, Buy, or Both):
      let totalMintsNFTs = 0;
      let totalBuysNFTs = 0;
      let mintEventsCount = 0;
      let buyEventsCount = 0;
      const mintersSet = new Set<string>();
      const buyersSet = new Set<string>();
      const qualifyingEventIds = new Set<string>();
      const txHashesList: string[] = [];

      for (const ev of allEventsForCollection) {
        if (allDistinctWallets.has(ev.wallet_address)) {
          qualifyingEventIds.add(ev.event_id);
          if (ev.event_type === 'mint') {
            mintersSet.add(ev.wallet_address);
            mintEventsCount++;
            totalMintsNFTs += ev.quantity;
          } else if (ev.event_type === 'sale') {
            buyersSet.add(ev.wallet_address);
            buyEventsCount++;
            totalBuysNFTs += ev.quantity;
          }
          if (ev.tx_hash && !txHashesList.includes(ev.tx_hash)) {
            txHashesList.push(ev.tx_hash);
          }
        }
      }

      const totalNFTs = totalMintsNFTs + totalBuysNFTs;

      let alertType: 'mint' | 'buy' | 'both';
      if (mintersSet.size > 0 && buyersSet.size > 0) {
        alertType = 'both';
      } else if (mintersSet.size > 0) {
        alertType = 'mint';
      } else {
        alertType = 'buy';
      }

      // 4. Threshold Milestone Enforcement:
      // Milestones: 3, 6, 10, 15 unique wallets
      const thresholds = getMilestoneThresholds(db);
      let currentMilestone: number | undefined = undefined;
      let nextMilestone: number | null = null;

      if (!bypassThreshold) {
        if (totalUniqueWallets < thresholds[0]) {
          // Suppress alert: below first milestone (e.g. 1 or 2 wallets)
          continue;
        }

        const achieved = getAchievedMilestones(collectionSlug, chain, 'all', totalUniqueWallets, db);
        if (achieved.eligibleMilestones.length === 0) {
          // Already alerted for current milestone; wait until next threshold (e.g. 6, 10, 15)
          continue;
        }

        currentMilestone = Math.max(...achieved.eligibleMilestones);
        nextMilestone = achieved.nextMilestone;

        // Atomically record milestone as alerted in SQLite
        recordMilestoneAlerted(collectionSlug, chain, 'all', currentMilestone, db);
        recordMilestoneAlerted(collectionSlug, chain, alertType, currentMilestone, db);
      } else {
        const achieved = getAchievedMilestones(collectionSlug, chain, 'all', totalUniqueWallets, db);
        currentMilestone = totalUniqueWallets >= thresholds[0]
          ? Math.max(...(achieved.eligibleMilestones.length > 0 ? achieved.eligibleMilestones : [thresholds[0]]))
          : undefined;
        nextMilestone = achieved.nextMilestone;
      }

      const qualifyingWalletsArray = Array.from(allDistinctWallets);

      // Format Telegram message
      const formattedMessage = this.formatTelegramMessage({
        alertType,
        collectionName: meta.name,
        chain,
        groupSummaries,
        totalUniqueWallets,
        totalNFTs,
        mintsCount: mintEventsCount,
        buysCount: buyEventsCount,
        qualifyingWallets: qualifyingWalletsArray,
        openseaUrl: meta.opensea_url,
        socials: {
          twitter: meta.twitter_url,
          discord: meta.discord_url,
          website: meta.website_url,
          telegram: meta.telegram_url,
        },
        milestone: currentMilestone,
        nextMilestone,
        isSimulation,
      });

      const alertId = `alert_${alertType}_${chain}_${collectionSlug}_${Date.now()}`;

      consolidatedAlerts.push({
        id: alertId,
        alertType,
        chain,
        collectionSlug,
        collectionName: meta.name,
        groups: groupSummaries,
        totalUniqueWallets,
        totalNFTs,
        mintsCount: mintEventsCount,
        buysCount: buyEventsCount,
        qualifyingActivity: alertType,
        qualifyingWallets: qualifyingWalletsArray,
        txHashes: txHashesList,
        openseaUrl: meta.opensea_url,
        socials: {
          twitter: meta.twitter_url,
          discord: meta.discord_url,
          website: meta.website_url,
          telegram: meta.telegram_url,
        },
        formattedMessage,
        timestamp: Date.now(),
        eventsCount: qualifyingEventIds.size,
        milestone: currentMilestone,
        nextMilestone,
      });
    }

    return consolidatedAlerts;
  }

  /**
   * Formats the consolidated alert with milestone notifications, group breakdowns, and links
   */
  public formatTelegramMessage(params: {
    alertType: 'mint' | 'buy' | 'both';
    collectionName: string;
    chain: string;
    contractAddress?: string;
    groupSummaries: ConsolidatedGroupSummary[];
    totalUniqueWallets: number;
    totalNFTs: number;
    mintsCount?: number;
    buysCount?: number;
    qualifyingWallets?: string[];
    openseaUrl: string;
    socials: {
      twitter?: string;
      discord?: string;
      website?: string;
      telegram?: string;
    };
    milestone?: number;
    nextMilestone?: number | null;
    isSimulation?: boolean;
  }): string {
    const isMint = params.alertType === 'mint';
    const isBuy = params.alertType === 'buy';
    const isBoth = params.alertType === 'both';

    let activityName = 'NFT Mint';
    let nounPlural = 'Minters';
    let verbAction = 'Minted';
    let headerTitle = '🔥 SMART MONEY MINT';

    if (isBuy) {
      activityName = 'NFT Purchase';
      nounPlural = 'Buyers';
      verbAction = 'Bought';
      headerTitle = '🔥 SMART MONEY BUY';
    } else if (isBoth) {
      activityName = 'Mint & Purchase';
      nounPlural = 'Wallets';
      verbAction = 'Acquired';
      headerTitle = `🔥 NFT SMART MONEY ALERT — ${params.milestone || params.totalUniqueWallets} UNIQUE WALLETS`;
    }

    // Milestone Badge
    let milestoneBadge = '';
    if (params.milestone === 3) {
      milestoneBadge = `🚨 *THRESHOLD REACHED: 3 UNIQUE WALLETS!* [Milestone 1/4]\n`;
    } else if (params.milestone === 6) {
      milestoneBadge = `🚨 *SURGE ALERT: 6 UNIQUE WALLETS!* [Milestone 2/4]\n`;
    } else if (params.milestone === 10) {
      milestoneBadge = `🚨 *MEGA SURGE: 10 UNIQUE WALLETS!* [Milestone 3/4]\n`;
    } else if (params.milestone === 15) {
      milestoneBadge = `🚨 *WHALE FRENZY: 15 UNIQUE WALLETS!* [Milestone 4/4]\n`;
    } else if (params.milestone) {
      milestoneBadge = `🚨 *ALERT: ${params.milestone} UNIQUE WALLETS!* [Milestone]\n`;
    }

    const formattedChain = params.chain.charAt(0).toUpperCase() + params.chain.slice(1).toLowerCase();

    const groupRows = params.groupSummaries
      .map((g) => `📁 ${g.groupName} — ${g.uniqueCount} ${nounPlural} | ${g.nftsCount} NFTs`)
      .join('\n');

    const socialLinks: string[] = [];
    if (params.socials.twitter) socialLinks.push(`[X/Twitter](${params.socials.twitter})`);
    if (params.socials.discord) socialLinks.push(`[Discord](${params.socials.discord})`);
    if (params.socials.website) socialLinks.push(`[Website](${params.socials.website})`);
    if (params.socials.telegram) socialLinks.push(`[Telegram](${params.socials.telegram})`);

    const socialsLine = socialLinks.length > 0 ? socialLinks.join(' • ') : 'None listed';

    const nextText = params.nextMilestone ? ` (Next alert at ${params.nextMilestone} wallets)` : ` (Max milestone reached)`;
    const milestoneSummary = params.milestone
      ? `🎯 Milestone: *${params.milestone} Unique Wallets*${nextText}\n`
      : '';

    const simNotice = params.isSimulation ? `🧪 *SIMULATED TEST ALERT*\n\n` : '';

    let activityDetails = '';
    if (isBoth) {
      activityDetails = `🔢 Activity Breakdown: ${params.mintsCount || 0} Mints | ${params.buysCount || 0} Purchases\n`;
    }

    let walletsSection = '';
    if (params.qualifyingWallets && params.qualifyingWallets.length > 0) {
      const topWallets = params.qualifyingWallets.slice(0, 6).map((addr) => `• \`${addr}\``).join('\n');
      const more = params.qualifyingWallets.length > 6 ? `\n• ...and ${params.qualifyingWallets.length - 6} more` : '';
      walletsSection = `\n👛 *Qualifying Wallets (${params.qualifyingWallets.length}):*\n${topWallets}${more}\n`;
    }

    const contractLine = params.contractAddress ? `📝 Contract: \`${params.contractAddress}\`\n` : '';

    return `${simNotice}${milestoneBadge}${headerTitle}

📦 Collection: ${params.collectionName}
⛓️ Chain: ${formattedChain}
${contractLine}
📊 Group Activity
${groupRows}

🔢 Total: ${params.totalUniqueWallets} Unique Wallets | ${params.totalNFTs} NFTs ${verbAction}
${activityDetails}${walletsSection}${milestoneSummary}⚡ Activity: ${activityName}
🔗 OpenSea: ${params.openseaUrl}
🌐 Socials: ${socialsLine}`;
  }
}

export const alertConsolidator = new AlertConsolidator();
