(function exposeLeadFilter() {
  const DEMAND_PATTERNS = [
    /\bcan tim\b/,
    /\btim (lop|gia su|thay|co|trung tam)\b/,
    /\bxin (review|gioi thieu|tu van)\b/,
    /\bco (lop|cho hoc|trung tam) nao\b/,
    /\bhoc (o dau|phi|them)\b/,
    /\bcon (minh|em|toi|nha minh)\b/,
    /\bmat goc\b/,
    /\bluyen thi\b/,
    /\bquan tam\b/,
  ];

  const RESPONSE_INTENT_PATTERNS = [
    /\b(cho|minh|em|anh|chi) xin\b/,
    /\bxin (hoc phi|gia|bao gia|dia chi|thong tin|lich hoc)\b/,
    /\b(hoc phi|gia bao nhieu|bao nhieu tien|dia chi|lich hoc)\b/,
    /\btu van (giup|minh|em|cho)\b/,
  ];

  const EDUCATION_PATTERNS = [
    /\b(toan|van|anh|ly|hoa|sinh|tieng anh)\b/,
    /\b(lop|khoi) ?([1-9]|1[0-2])\b/,
    /\b(gia su|hoc them|luyen thi|trung tam|giao vien)\b/,
    /\b(ielts|toeic|cambridge|vao 10|thi dai hoc)\b/,
  ];

  const PROMOTION_PATTERNS = [
    /\b(inbox|ib|nhan tin) (em|co|thay|minh)\b/,
    /\bben (em|minh|co|thay)\b/,
    /\b(co|thay|em|minh) co lop\b/,
    /\b(tham khao|tham khảo) (lop|co|thay|trung tam)\b/,
    /\b(lop|khoa) (co|thay|ben em|ben minh)\b/,
    /\b(co|thay) moi (bo me|phu huynh|cac con)\b/,
    /\bnhan (day|kem|gia su)\b/,
    /\b(tuyen sinh|chuyen luyen|day kem|hoc thu)\b/,
    /\b(dang ky|khai giang|uu dai|cam ket dau ra|lien he)\b/,
    /\b(sdt|sddt|so dien thoai|zalo)\b/,
  ];

  const COMPETITOR_PATTERNS = [
    /\btrung tam (ben|cua)? ?(em|minh|chung toi)?\b/,
    /\b(doi ngu giao vien|chuong trinh hoc|hoc vien)\b/,
    /\b(hotline|fanpage|website|khai giang|uu dai|tuyen sinh)\b/,
  ];

  const RECOMMENDATION_PATTERNS = [
    /\b(thay|co|trung tam) .{0,40} (day|hoc) (tot|ok|on)\b/,
    /\bminh (gioi thieu|recommend)\b/,
    /\bban thu (lien he|hoi)\b/,
  ];

  function analyze(items) {
    const groups = new Map();

    for (const item of items || []) {
      if (!item?.text || !item?.authorName) continue;
      const key =
        normalizeProfileUrl(item.authorUrl) ||
        `name:${normalizeText(item.authorName)}`;
      const group = groups.get(key) || {
        profileKey: key,
        authorName: item.authorName,
        authorUrl: item.authorUrl || '',
        items: [],
      };
      group.items.push(item);
      if (!group.authorUrl && item.authorUrl) group.authorUrl = item.authorUrl;
      groups.set(key, group);
    }

    const profiles = [...groups.values()]
      .map(classifyProfile)
      .sort((a, b) => b.leadScore - a.leadScore);
    const summary = {
      totalProfiles: 0,
      POTENTIAL_PARENT: 0,
      TEACHER_AD: 0,
      COMPETITOR_SALE: 0,
      RECOMMENDATION: 0,
      NEUTRAL: 0,
      SPAM: 0,
      HOT: 0,
      WARM: 0,
      COLD: 0,
    };
    for (const profile of profiles) {
      summary.totalProfiles += 1;
      summary[profile.classification] += 1;
      if (profile.leadLevel && profile.leadLevel !== 'NONE') {
        summary[profile.leadLevel] += 1;
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      summary,
      profiles,
      aiCandidates: profiles.filter(
        (profile) =>
          profile.classification === 'POTENTIAL_PARENT' &&
          profile.leadScore >= 30,
      ),
    };
  }

  function classifyProfile(group) {
    const ownTexts = group.items.map((item) => normalizeText(item.text));
    const itemAnalyses = group.items.map(analyzeProfileItem);
    const uniqueTexts = [...new Set(ownTexts)];
    const uniquePosts = new Set(
      group.items.map((item) => item.pageUrl || item.sourceUrl).filter(Boolean),
    ).size;
    const combinedText = uniqueTexts.join(' ');
    const duplicateRatio =
      ownTexts.length > 1
        ? 1 - uniqueTexts.length / ownTexts.length
        : 0;
    const phoneCount = (
      combinedText.match(/(?:\+?84|0)(?:\d[\s.-]?){8,10}\b/g) || []
    ).length;
    const linkCount = (combinedText.match(/https?:\/\/|www\.|facebook\.com/g) || [])
      .length;
    const demandHits = sumMetric(itemAnalyses, 'ownDemandHits');
    const responseIntentHits = sumMetric(itemAnalyses, 'responseIntentHits');
    const educationHits = sumMetric(itemAnalyses, 'educationHits');
    const ownEducationHits = sumMetric(itemAnalyses, 'ownEducationHits');
    const contextEducationHits = sumMetric(itemAnalyses, 'contextEducationHits');
    const promotionHits = sumMetric(itemAnalyses, 'promotionHits');
    const competitorHits = sumMetric(itemAnalyses, 'competitorHits');
    const recommendationHits = sumMetric(itemAnalyses, 'recommendationHits');
    const bestLeadEvidence = maxByScore(itemAnalyses, 'leadScore');
    const bestPromotionEvidence = maxByScore(itemAnalyses, 'promotionScore');
    const bestRecommendationEvidence = maxByScore(
      itemAnalyses,
      'recommendationScore',
    );
    const repeatedAcrossPosts = uniquePosts >= 3 && duplicateRatio >= 0.35;

    const promotionScore = clamp(
      Number(bestPromotionEvidence?.promotionScore || 0) +
        Math.min(promotionHits, 3) * 8 +
        Math.min(competitorHits, 2) * 10 +
        Math.min(phoneCount, 2) * 15 +
        Math.min(linkCount, 2) * 15 +
        (repeatedAcrossPosts ? 40 : 0) +
        (uniquePosts >= 5 ? 15 : 0),
      0,
      100,
    );
    const secondaryLeadScore = itemAnalyses
      .filter((item) => item !== bestLeadEvidence && item.leadScore >= 25)
      .reduce((total, item) => total + item.leadScore * 0.2, 0);
    const leadScore = clamp(
      Number(bestLeadEvidence?.leadScore || 0) +
        Math.min(secondaryLeadScore, 20) -
        promotionScore * 0.65 -
        (duplicateRatio >= 0.6 ? 20 : 0),
      0,
      100,
    );
    const recommendationScore = Number(
      bestRecommendationEvidence?.recommendationScore || 0,
    );
    const hasOwnLeadIntent = demandHits + responseIntentHits > 0;
    const hasEducationContext = educationHits > 0;

    let classification = 'NEUTRAL';
    const reasons = [];
    if (repeatedAcrossPosts && promotionScore >= 55) {
      classification = 'COMPETITOR_SALE';
      reasons.push('Nội dung quảng cáo lặp lại trên nhiều bài');
    } else if (
      promotionScore >= 55 &&
      (competitorHits >= 2 ||
        (competitorHits >= 1 &&
          (phoneCount > 0 || linkCount > 0 || uniquePosts >= 2)))
    ) {
      classification = 'COMPETITOR_SALE';
      reasons.push('Có dấu hiệu trung tâm hoặc đơn vị sale');
    } else if (promotionHits >= 1 && promotionScore >= 18) {
      classification = 'TEACHER_AD';
      reasons.push('Có lời mời học, nhận dạy hoặc để lại liên hệ');
    } else if (
      hasOwnLeadIntent &&
      hasEducationContext &&
      leadScore >= 30
    ) {
      classification = 'POTENTIAL_PARENT';
      reasons.push(
        `Có nhu cầu học tập rõ ở ${getLevelLabel(bestLeadEvidence?.level)}`,
      );
    } else if (recommendationScore >= 20 || recommendationHits >= 1) {
      classification = 'RECOMMENDATION';
      reasons.push('Đang giới thiệu giáo viên hoặc trung tâm');
    } else if (
      group.items.length >= 5 &&
      (duplicateRatio >= 0.7 || combinedText.length < 30)
    ) {
      classification = 'SPAM';
      reasons.push('Nội dung ngắn hoặc lặp lại nhiều lần');
    }

    if (ownEducationHits) reasons.push('Tự nhắc tới môn/lớp/việc học');
    else if (contextEducationHits) reasons.push('Ngữ cảnh cha là giáo dục');
    if (uniquePosts >= 3) reasons.push(`Xuất hiện trong ${uniquePosts} bài`);
    if (phoneCount) reasons.push('Có số điện thoại');

    return {
      profileKey: group.profileKey,
      authorName: group.authorName,
      authorUrl: group.authorUrl,
      classification,
      leadScore,
      leadLevel: getLeadLevel(leadScore, classification),
      promotionScore,
      recommendationScore,
      reasons,
      metrics: {
        totalItems: group.items.length,
        uniquePosts,
        duplicateRatio: Number(duplicateRatio.toFixed(2)),
        phoneCount,
        linkCount,
        demandHits,
        responseIntentHits,
        educationHits,
        ownEducationHits,
        contextEducationHits,
        promotionHits,
        competitorHits,
        recommendationHits,
        bestEvidenceLevel: bestLeadEvidence?.level || 'NONE',
      },
      evidence: itemAnalyses
        .sort(
          (a, b) =>
            Math.max(b.leadScore, b.promotionScore, b.recommendationScore) -
            Math.max(a.leadScore, a.promotionScore, a.recommendationScore),
        )
        .slice(0, 5)
        .map(({ item, level, label, leadScore: itemLeadScore }) => ({
          ...item,
          evidenceLevel: level,
          evidenceLabel: label,
          itemLeadScore: Math.round(itemLeadScore),
        })),
    };
  }

  function analyzeProfileItem(item) {
    const ownText = normalizeText(item.text);
    const parentContextText = getParentContextText(item);
    const fullContextText = [parentContextText, ownText]
      .filter(Boolean)
      .join(' ');
    const level = getItemLevel(item);
    const levelWeight = getLevelWeight(level);
    const ownDemandHits = countMatches(ownText, DEMAND_PATTERNS);
    const responseIntentHits = countMatches(ownText, RESPONSE_INTENT_PATTERNS);
    const ownEducationHits = countMatches(ownText, EDUCATION_PATTERNS);
    const contextEducationHits = countMatches(
      parentContextText,
      EDUCATION_PATTERNS,
    );
    const educationHits = countMatches(fullContextText, EDUCATION_PATTERNS);
    const promotionHits = countMatches(ownText, PROMOTION_PATTERNS);
    const competitorHits = countMatches(ownText, COMPETITOR_PATTERNS);
    const recommendationHits = countMatches(ownText, RECOMMENDATION_PATTERNS);
    const phoneCount = (
      ownText.match(/(?:\+?84|0)(?:\d[\s.-]?){8,10}\b/g) || []
    ).length;
    const linkCount = (ownText.match(/https?:\/\/|www\.|facebook\.com/g) || [])
      .length;
    const hasLeadIntent = ownDemandHits + responseIntentHits > 0;
    const isQuestion =
      /\b(ai biet|co ai|o dau|bao nhieu|khong|k a|ko|khong a)\b/.test(
        ownText,
      ) || /\?$/.test(ownText);
    const leadBase =
      hasLeadIntent && educationHits
        ? ownDemandHits * 32 +
          responseIntentHits * 24 +
          ownEducationHits * 16 +
          contextEducationHits * 9 +
          (item.kind === 'POST' ? 12 : 0) +
          (isQuestion ? 8 : 0)
        : 0;
    const promotionScore = clamp(
      promotionHits * 24 +
        competitorHits * 26 +
        Math.min(phoneCount, 2) * 18 +
        Math.min(linkCount, 2) * 16,
      0,
      100,
    );
    const recommendationScore = clamp(recommendationHits * 24, 0, 100);

    return {
      item,
      level,
      label: getLevelLabel(level),
      ownDemandHits,
      responseIntentHits,
      ownEducationHits,
      contextEducationHits,
      educationHits,
      promotionHits,
      competitorHits,
      recommendationHits,
      leadScore: clamp(leadBase * levelWeight - promotionScore * 0.8, 0, 100),
      promotionScore,
      recommendationScore,
    };
  }

  function getParentContextText(item) {
    if (!Array.isArray(item.contextTexts) || item.contextTexts.length <= 1) {
      return '';
    }
    const ownText = normalizeText(item.text);
    return item.contextTexts
      .map(normalizeText)
      .filter((text) => text && text !== ownText)
      .join(' ');
  }

  function getItemLevel(item) {
    if (item.kind === 'POST') return 'POST';
    const depth = Number(item.depth || 1);
    if (depth <= 1) return 'COMMENT';
    if (depth === 2) return 'REPLY';
    return 'DEEP_REPLY';
  }

  function getLevelWeight(level) {
    return (
      {
        POST: 1.15,
        COMMENT: 1,
        REPLY: 0.85,
        DEEP_REPLY: 0.7,
      }[level] || 1
    );
  }

  function getLevelLabel(level) {
    return (
      {
        POST: 'bài gốc',
        COMMENT: 'bình luận cấp 1',
        REPLY: 'phản hồi cấp 2',
        DEEP_REPLY: 'phản hồi cấp sâu',
        NONE: 'không rõ cấp',
      }[level] || 'không rõ cấp'
    );
  }

  function getLeadLevel(score, classification) {
    if (classification !== 'POTENTIAL_PARENT') return 'NONE';
    if (score >= 75) return 'HOT';
    if (score >= 50) return 'WARM';
    if (score >= 30) return 'COLD';
    return 'NONE';
  }

  function sumMetric(items, key) {
    return items.reduce((total, item) => total + Number(item[key] || 0), 0);
  }

  function maxByScore(items, key) {
    return [...items].sort(
      (a, b) => Number(b[key] || 0) - Number(a[key] || 0),
    )[0] || null;
  }

  function countMatches(text, patterns) {
    return patterns.reduce(
      (total, pattern) => total + (pattern.test(text) ? 1 : 0),
      0,
    );
  }

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s:+./-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeProfileUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value);
      for (const key of ['__cft__', '__tn__', 'mibextid', 'ref']) {
        url.searchParams.delete(key);
      }
      url.hash = '';
      return url.toString();
    } catch {
      return '';
    }
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  window.DaoEduLeadFilter = { analyze };
})();
