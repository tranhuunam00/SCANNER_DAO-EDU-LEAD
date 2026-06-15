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
    };
    for (const profile of profiles) {
      summary.totalProfiles += 1;
      summary[profile.classification] += 1;
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
    const contextualTexts = group.items.map((item) =>
      normalizeText(getItemAnalysisText(item)),
    );
    const uniqueTexts = [...new Set(ownTexts)];
    const uniquePosts = new Set(
      group.items.map((item) => item.pageUrl || item.sourceUrl).filter(Boolean),
    ).size;
    const combinedText = uniqueTexts.join(' ');
    const contextualText = [...new Set(contextualTexts)].join(' ');
    const duplicateRatio =
      ownTexts.length > 1
        ? 1 - uniqueTexts.length / ownTexts.length
        : 0;
    const phoneCount = (
      combinedText.match(/(?:\+?84|0)(?:\d[\s.-]?){8,10}\b/g) || []
    ).length;
    const linkCount = (combinedText.match(/https?:\/\/|www\.|facebook\.com/g) || [])
      .length;
    const demandHits = countMatches(contextualText, DEMAND_PATTERNS);
    const educationHits = countMatches(contextualText, EDUCATION_PATTERNS);
    const promotionHits = countMatches(combinedText, PROMOTION_PATTERNS);
    const competitorHits = countMatches(combinedText, COMPETITOR_PATTERNS);
    const recommendationHits = countMatches(
      combinedText,
      RECOMMENDATION_PATTERNS,
    );
    const repeatedAcrossPosts = uniquePosts >= 3 && duplicateRatio >= 0.35;

    const promotionScore = clamp(
      promotionHits * 18 +
        competitorHits * 22 +
        Math.min(phoneCount, 2) * 15 +
        Math.min(linkCount, 2) * 15 +
        (repeatedAcrossPosts ? 40 : 0) +
        (uniquePosts >= 5 ? 15 : 0),
      0,
      100,
    );
    const leadScore = clamp(
      demandHits * 25 +
        educationHits * 12 +
        (group.items.some((item) => item.kind === 'POST') ? 8 : 0) -
        promotionScore -
        (duplicateRatio >= 0.6 ? 20 : 0),
      0,
      100,
    );

    let classification = 'NEUTRAL';
    const reasons = [];
    if (repeatedAcrossPosts && promotionScore >= 55) {
      classification = 'COMPETITOR_SALE';
      reasons.push('Nội dung quảng cáo lặp lại trên nhiều bài');
    } else if (competitorHits >= 1 && promotionScore >= 40) {
      classification = 'COMPETITOR_SALE';
      reasons.push('Có dấu hiệu trung tâm hoặc đơn vị sale');
    } else if (promotionHits >= 1 && promotionScore >= 18) {
      classification = 'TEACHER_AD';
      reasons.push('Có lời mời học, nhận dạy hoặc để lại liên hệ');
    } else if (demandHits >= 1 && educationHits >= 1 && leadScore >= 30) {
      classification = 'POTENTIAL_PARENT';
      reasons.push('Có nhu cầu học tập rõ ràng');
    } else if (recommendationHits >= 1) {
      classification = 'RECOMMENDATION';
      reasons.push('Đang giới thiệu giáo viên hoặc trung tâm');
    } else if (
      group.items.length >= 5 &&
      (duplicateRatio >= 0.7 || combinedText.length < 30)
    ) {
      classification = 'SPAM';
      reasons.push('Nội dung ngắn hoặc lặp lại nhiều lần');
    }

    if (educationHits) reasons.push('Có ngữ cảnh giáo dục');
    if (uniquePosts >= 3) reasons.push(`Xuất hiện trong ${uniquePosts} bài`);
    if (phoneCount) reasons.push('Có số điện thoại');

    return {
      profileKey: group.profileKey,
      authorName: group.authorName,
      authorUrl: group.authorUrl,
      classification,
      leadScore,
      promotionScore,
      reasons,
      metrics: {
        totalItems: group.items.length,
        uniquePosts,
        duplicateRatio: Number(duplicateRatio.toFixed(2)),
        phoneCount,
        linkCount,
        demandHits,
        educationHits,
        promotionHits,
        competitorHits,
      },
      evidence: group.items.slice(-5).reverse(),
    };
  }

  function getItemAnalysisText(item) {
    if (Array.isArray(item.contextTexts) && item.contextTexts.length) {
      return item.contextTexts.join(' ');
    }
    return item.text || '';
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
