const EXPAND_TEXT_PATTERNS = [
  /^xem thêm bình luận$/i,
  /^xem \d+ bình luận$/i,
  /^xem tất cả \d+ bình luận$/i,
  /^xem các bình luận trước$/i,
  /^view more comments$/i,
  /^view all \d+ comments$/i,
  /^xem thêm phản hồi$/i,
  /^xem tất cả \d+ phản hồi$/i,
  /^xem \d+ phản hồi$/i,
  /^view more replies$/i,
  /^view \d+ replies$/i,
];

const STORAGE_KEY = 'daoEduLeadScannerItems';
const META_KEY = 'daoEduLeadScannerMeta';
const SCANNED_URLS_KEY = 'daoEduLeadScannerScannedPostUrls';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'PING_SCANNER') {
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === 'COLLECT_POST_LINKS') {
    sendResponse(
      collectPostLinks(message.scannedUrls || [], message.limit || 100),
    );
    return;
  }

  if (message?.type === 'DEEP_SCAN_CURRENT_POST') {
    deepScanCurrentPost(
      Number(message.maxRounds) || 20,
      Number(message.maxClicksPerRound) || 40,
    )
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, error: error.message || String(error) }),
      );
    return true;
  }

  if (message?.type === 'DEEP_SCAN_AND_SAVE_CURRENT_POST') {
    deepScanCurrentPost(
      Number(message.maxRounds) || 20,
      Number(message.maxClicksPerRound) || 40,
    )
      .then(async (result) => {
        if (!result?.ok) return result;
        await saveScanResultLocally(result);
        await markPostScannedLocally(result.summary.postUrl);
        return result;
      })
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, error: error.message || String(error) }),
      );
    return true;
  }

  if (message?.type === 'SCROLL_GROUP_FEED') {
    window.scrollBy({
      top: Math.max(window.innerHeight * 0.9, 750),
      behavior: 'smooth',
    });
    sendResponse({ ok: true });
    return;
  }
});

async function saveScanResultLocally(result) {
  const data = await chrome.storage.local.get([STORAGE_KEY, META_KEY]);
  const existing = data[STORAGE_KEY] || [];
  const currentPostId = result.summary.postId;
  const retained = existing.filter(
    (item) =>
      Number(item.parserVersion || 0) >= 21 &&
      isPostUrl(item.pageUrl) &&
      item.pageUrl !== result.summary.postUrl &&
      item.postId !== currentPostId,
  );
  const map = new Map(retained.map((item) => [item.fingerprint, item]));

  for (const item of result.items || []) {
    map.set(item.fingerprint, {
      ...map.get(item.fingerprint),
      ...item,
      lastSeenAt: new Date().toISOString(),
    });
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: [...map.values()],
    [META_KEY]: {
      scannedAt: new Date().toISOString(),
      postUrl: result.summary.postUrl,
      postId: result.summary.postId,
      lastPostCount: result.summary.posts,
      lastCommentCount: result.summary.comments,
      clickedExpanders: result.summary.clickedExpanders,
    },
  });
}

async function markPostScannedLocally(postUrl) {
  const urls = await getScannedUrlSet();
  urls.add(normalizePostUrl(postUrl));
  await chrome.storage.local.set({ [SCANNED_URLS_KEY]: [...urls] });
}

async function getScannedUrlSet() {
  const data = await chrome.storage.local.get(SCANNED_URLS_KEY);
  return new Set(
    (data[SCANNED_URLS_KEY] || []).map((url) => normalizePostUrl(url)),
  );
}

function isPostUrl(value) {
  try {
    return /\/groups\/[^/]+\/(?:posts|permalink)\/\d+/.test(
      new URL(value, location.origin).pathname,
    );
  } catch {
    return false;
  }
}

async function deepScanCurrentPost(maxRounds, maxClicksPerRound) {
  await waitForPostContent(15000);

  const pinnedPostUrl = getPostUrlForRoot(getPostRoot());
  if (!isPostUrl(pinnedPostUrl)) {
    return {
      ok: false,
      error: 'Hay mo rieng mot bai viet Facebook truoc khi quet.',
    };
  }

  let clickedExpanders = 0;
  let emptyRounds = 0;
  let previousScrollHeight = 0;
  const collected = new Map();
  let latestSummary = null;
  let lastScanError = '';

  if (!collectScanSnapshot()) {
    return {
      ok: false,
      error: lastScanError || 'Khong doc duoc bai viet dang mo.',
    };
  }

  for (let round = 1; round <= maxRounds; round += 1) {
    const result = await expandCommentRound(maxClicksPerRound);
    clickedExpanders += result.clickedExpanders;

    const grew = result.scrollHeight > previousScrollHeight;
    previousScrollHeight = Math.max(previousScrollHeight, result.scrollHeight);
    emptyRounds =
      result.clickedExpanders === 0 && !grew ? emptyRounds + 1 : 0;

    if (emptyRounds >= 2) break;
    await sleep(result.clickedExpanders > 0 ? 1600 : 900);
    collectScanSnapshot();
  }

  await sleep(700);
  collectScanSnapshot();

  const collectedItems = [...collected.values()];
  const post = collectedItems.find((item) => item.kind === 'POST') || null;
  const comments = resolveCommentRelationships(
    refineFlattenedThreadParents(
      collectedItems.filter((item) => item.kind === 'COMMENT'),
    ),
    post,
  );
  const items = [post, ...comments].filter(Boolean);
  const commentCount = comments.length;
  const posts = post ? 1 : 0;

  return {
    ok: true,
    items,
    summary: {
      ...latestSummary,
      posts,
      comments: commentCount,
      clickedExpanders,
    },
  };

  function collectScanSnapshot() {
    const scan = scanCurrentPost(pinnedPostUrl);
    if (!scan.ok) {
      lastScanError = scan.error || '';
      return false;
    }
    latestSummary = scan.summary;
    for (const item of scan.items) {
      const existing = collected.get(item.fingerprint);
      const shouldReplace =
        !existing ||
        (item.kind === 'POST' && !existing.text && item.text) ||
        (item.kind === 'COMMENT' &&
          Number(item.depth || 0) > Number(existing.depth || 0));
      if (shouldReplace) collected.set(item.fingerprint, item);
    }
    return true;
  }
}

async function expandCommentRound(maxClicks) {
  const candidates = findCommentExpanders().slice(0, maxClicks);
  let clickedExpanders = 0;

  for (const node of candidates) {
    if (!(node instanceof Element) || !node.isConnected || !isVisible(node)) {
      continue;
    }
    node.dataset.daoEduScannerClicked = 'true';
    node.click();
    clickedExpanders += 1;
    await sleep(80);
  }

  const scrollContainer = findCommentsScrollContainer();
  if (scrollContainer) {
    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: 'smooth',
    });
  } else {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  return {
    ok: true,
    clickedExpanders,
    scrollTop: scrollContainer?.scrollTop || window.scrollY || 0,
    scrollHeight:
      scrollContainer?.scrollHeight || document.documentElement.scrollHeight,
  };
}

async function waitForPostContent(timeoutMilliseconds) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMilliseconds) {
    const root = getPostRoot();
    if (
      root.querySelector(
        '[data-ad-preview="message"], [data-ad-comet-preview="message"], [role="article"]',
      )
    ) {
      await sleep(800);
      return;
    }
    await sleep(500);
  }
  throw new Error('Facebook did not render the post content in time.');
}

function scanCurrentPost(postUrlOverride = '') {
  try {
    const root = getPostRoot();
    const postUrl = postUrlOverride || getPostUrlForRoot(root);
    if (!isPostUrl(postUrl)) {
      throw new Error(
        'Hay mo rieng mot bai viet hoac mo dialog bai viet truoc khi quet.',
      );
    }
    const expectedPostId = extractPostId(postUrl);
    const warnings = [];
    let post = null;
    let comments = [];

    try {
      comments = parseAllComments(root, null, postUrl);
    } catch (error) {
      warnings.push(`COMMENTS: ${error.message || String(error)}`);
    }

    try {
      post = parseOriginalPost(root, postUrl, comments);
    } catch (error) {
      warnings.push(`POST: ${error.message || String(error)}`);
      post = createMissingOriginalPost(postUrl);
    }
    comments = comments.filter(
      (comment) => comment.postId === expectedPostId,
    );
    comments = resolveCommentRelationships(
      refineFlattenedThreadParents(comments),
      post,
    );
    const items = uniqueByFingerprint([post, ...comments].filter(Boolean));

    return {
      ok: true,
      items,
      summary: {
        posts: post ? 1 : 0,
        comments: comments.length,
        visibleArticles: root.querySelectorAll('[role="article"]').length,
        topLevelArticles: 0,
        groupUrl: getGroupUrl(),
        postUrl,
        postId: expectedPostId,
        postDetected: Boolean(post?.text),
        warnings,
      },
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function getPostUrlForRoot(root) {
  const currentUrl = getCanonicalPostUrl();
  if (isPostUrl(currentUrl)) return currentUrl;
  if (!(root instanceof Element) || !root.matches('[role="dialog"]')) return '';

  const urls = [...root.querySelectorAll('a[href]')]
    .map((link) => cleanFacebookUrl(link.href))
    .filter(isPostUrl)
    .map(normalizePostUrl);
  if (!urls.length) return '';

  const counts = new Map();
  for (const url of urls) counts.set(url, Number(counts.get(url) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function getPostRoot() {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(
    isVisible,
  );
  return (
    dialogs.sort(
      (a, b) =>
        b.getBoundingClientRect().width * b.getBoundingClientRect().height -
        a.getBoundingClientRect().width * a.getBoundingClientRect().height,
    )[0] || document
  );
}

function collectPostLinks(scannedUrls, limit) {
  const scanned = new Set(scannedUrls.map(normalizePostUrl));
  applyScannedMarkers(scanned);
  const links = [...document.querySelectorAll('a[href]')]
    .map((link) => link.href)
    .filter(
      (href) =>
        /\/groups\/[^/]+\/(?:posts|permalink)\/\d+/.test(href) &&
        !href.includes('comment_id='),
    )
    .map(normalizePostUrl);

  return {
    ok: true,
    urls: [...new Set(links)]
      .filter((url) => !scanned.has(url))
      .slice(0, limit),
    groupUrl: getGroupUrl(),
  };
}

function applyScannedMarkers(scanned) {
  for (const link of document.querySelectorAll('a[href]')) {
    const normalized = normalizePostUrl(link.href);
    if (!scanned.has(normalized)) continue;

    const article = link.closest('[role="article"]');
    if (!article || article.dataset.daoEduScanned === 'true') continue;
    article.dataset.daoEduScanned = 'true';

    const badge = document.createElement('div');
    badge.textContent = 'DAO EDU: Đã quét';
    badge.dataset.daoEduScanBadge = 'true';
    Object.assign(badge.style, {
      position: 'absolute',
      top: '8px',
      right: '8px',
      zIndex: '20',
      padding: '5px 8px',
      borderRadius: '999px',
      color: '#ffffff',
      background: '#15803d',
      fontSize: '11px',
      fontWeight: '700',
      boxShadow: '0 2px 8px rgba(0,0,0,.18)',
    });

    const position = window.getComputedStyle(article).position;
    if (position === 'static') article.style.position = 'relative';
    article.appendChild(badge);
  }
}

function parseOriginalPost(root, postUrl, comments = []) {
  const messageNodes = [
    ...root.querySelectorAll('[data-ad-preview="message"]'),
    ...root.querySelectorAll('[data-ad-comet-preview="message"]'),
  ];
  const originalPostArticle = findOriginalPostArticle(root, postUrl);

  const messageNode = messageNodes
    .map((node) => ({
      node,
      text: cleanText(node.innerText),
      belongsToOriginalPost:
        originalPostArticle &&
        node.closest('[role="article"]') === originalPostArticle,
    }))
    .filter(
      ({ text, belongsToOriginalPost }) =>
        belongsToOriginalPost && isUsefulContent(text),
    )
    .sort((a, b) => b.text.length - a.text.length)[0];

  const fallbackArticle = originalPostArticle;
  const fallbackText =
    extractOriginalPostText(fallbackArticle) ||
    extractPostTextFromRoot(root, originalPostArticle, comments);
  if (!messageNode && !fallbackText) {
    return isPostUrl(postUrl)
      ? createMissingOriginalPost(postUrl)
      : null;
  }

  const container = messageNode
    ? findPostContainer(messageNode.node, root)
    : fallbackArticle
      ? cloneWithoutNestedArticles(fallbackArticle)
      : null;
  const author = container
    ? findAuthor(container, { preferHeader: true })
    : { name: '', url: '' };
  const text = messageNode?.text || fallbackText;
  return createItem({
    kind: 'POST',
    author,
    text,
    sourceUrl: postUrl,
    parentFingerprint: null,
    postId: extractPostId(postUrl),
    commentId: null,
    parentCommentId: null,
    depth: 0,
    treePath: '',
    contextTexts: [text],
  });
}

function extractPostTextFromRoot(root, originalPostArticle, comments) {
  if (!(root instanceof Element)) return '';

  const commentTexts = new Set(
    comments.map((comment) => cleanText(comment.text)).filter(Boolean),
  );
  const commentAuthors = new Set(
    comments.map((comment) => cleanText(comment.authorName)).filter(Boolean),
  );
  const interactionTop = findPostInteractionTop(root, originalPostArticle);
  if (!Number.isFinite(interactionTop)) return '';

  const candidates = [
    ...root.querySelectorAll(
      '[data-ad-preview="message"], [data-ad-comet-preview="message"], [dir="auto"]',
    ),
  ]
    .filter((node) => {
      const article = node.closest('[role="article"]');
      return (
        isVisible(node) &&
        (!article || article === originalPostArticle) &&
        !node.closest('a, button, [role="button"]') &&
        node.getBoundingClientRect().bottom <= interactionTop
      );
    })
    .map((node) => cleanText(node.innerText))
    .filter(isUsefulContent)
    .filter((text) => !commentTexts.has(text))
    .filter((text) => !commentAuthors.has(text))
    .filter((text) => !isInterfaceText(text))
    .filter((text) => !isMetadataText(text));

  return [...new Set(candidates)].sort((a, b) => b.length - a.length)[0] || '';
}

function findPostInteractionTop(root, originalPostArticle) {
  const tops = [...root.querySelectorAll('[role="button"], button')]
    .filter(isVisible)
    .filter((node) => {
      const article = node.closest('[role="article"]');
      if (article && article !== originalPostArticle) return false;
      const text = normalizeUiText(
        node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          node.innerText ||
          node.textContent,
      );
      return /^(thich|binh luan|chia se|like|comment|share)(\b|:)/.test(text);
    })
    .map((node) => node.getBoundingClientRect().top)
    .filter(Number.isFinite);
  return tops.length ? Math.min(...tops) : Number.NaN;
}

function extractOriginalPostText(article) {
  if (!(article instanceof Element)) return '';

  const scope = cloneWithoutNestedArticles(article);
  const author = findAuthor(scope, { preferHeader: true });
  const candidates = [
    ...scope.querySelectorAll(
      '[data-ad-preview="message"], [data-ad-comet-preview="message"], [dir="auto"]',
    ),
  ]
    .filter((node) => !node.closest('a, button, [role="button"]'))
    .map((node) => cleanText(node.innerText))
    .filter(isUsefulContent)
    .filter((text) => text !== author.name)
    .filter((text) => !isInterfaceText(text))
    .filter((text) => !isMetadataText(text));

  return [...new Set(candidates)].sort((a, b) => b.length - a.length)[0] || '';
}

function createMissingOriginalPost(postUrl, author = null) {
  return {
    ...createItem({
      kind: 'POST',
      author: author || { name: '', url: '' },
      text: '',
      sourceUrl: postUrl,
      parentFingerprint: null,
      postId: extractPostId(postUrl),
      commentId: null,
      parentCommentId: null,
      depth: 0,
      treePath: '',
      contextTexts: [],
    }),
    missingPostContent: true,
  };
}

function findOriginalPostArticle(root, postUrl) {
  const normalizedPostUrl = normalizePostUrl(postUrl);
  const articles = uniqueNodes(
    [...root.querySelectorAll('a[href]')]
      .filter((link) => isDirectPostLink(link.href, normalizedPostUrl))
      .map((link) => findPostArticleForLink(link, normalizedPostUrl))
      .filter(Boolean),
  );

  return (
    articles
      .map((article) => {
        const rect = article.getBoundingClientRect();
        return {
          article,
          top: rect.top,
          area: rect.width * rect.height,
        };
      })
      .sort((a, b) => a.top - b.top || b.area - a.area)[0]?.article || null
  );
}

function findPostArticleForLink(node, normalizedPostUrl) {
  let current = node instanceof Element ? node : null;
  const candidates = [];

  while (current && current !== document.body) {
    if (current.matches?.('[role="article"]')) {
      const ownScope = cloneWithoutNestedArticles(current);
      const hasDirectPostLink = [...ownScope.querySelectorAll('a[href]')].some(
        (link) => isDirectPostLink(link.href, normalizedPostUrl),
      );
      if (hasDirectPostLink && !findCommentPermalink(ownScope)) {
        const rect = current.getBoundingClientRect();
        candidates.push({
          article: current,
          area: rect.width * rect.height,
        });
      }
    }
    current = current.parentElement;
  }

  return candidates.sort((a, b) => b.area - a.area)[0]?.article || null;
}

function findPostContainer(messageNode, root) {
  let current = messageNode.parentElement;
  while (current && current !== root) {
    const profileLinks = [...current.querySelectorAll('a[href]')].filter(
      (link) => isProfileUrl(link.getAttribute('href') || ''),
    );
    if (profileLinks.length && current.getBoundingClientRect().width > 300) {
      return current;
    }
    current = current.parentElement;
  }
  return messageNode.parentElement || root;
}

function parseAllComments(root, post, postUrl) {
  const postId = extractPostId(postUrl);
  const originalPostArticle = findOriginalPostArticle(root, postUrl);
  const articleNodes = [...root.querySelectorAll('[role="article"]')].filter(
    (node) =>
      isVisible(node) &&
      cleanText(node.innerText).length >= 2 &&
      node !== originalPostArticle &&
      articleBelongsToPost(node, postId, root),
  );
  const postText = post?.text || '';
  const parsedByArticle = new Map();
  const parsedThreadRootByContainer = new Map();
  const visualStack = [];

  for (const article of articleNodes) {
    try {
      const threadContainer = findCommentThreadContainer(article, root);
      const threadRootItem = threadContainer
        ? parsedThreadRootByContainer.get(threadContainer) || null
        : null;
      const parentArticle = findParentCommentArticle(article, root);
      const nestedParentItem = parentArticle
        ? parsedByArticle.get(parentArticle) || null
        : null;
      const visualLeft = getCommentVisualLeft(article);
      let parentIndex = visualStack.length - 1;
      while (
        parentIndex >= 0 &&
        visualStack[parentIndex].left >= visualLeft - 8
      ) {
        parentIndex -= 1;
      }
      const visualParentItem =
        visualStack[parentIndex]?.item || null;
      const item = parseCommentArticle(article, {
        parentFingerprint: post?.fingerprint || null,
        postUrl,
        postId,
        postText,
        parentItem: visualParentItem || nestedParentItem,
        precedingItems: [...parsedByArticle.values()],
        threadRootItem,
      });
      if (item) {
        parsedByArticle.set(article, item);
        if (threadContainer && !threadRootItem) {
          parsedThreadRootByContainer.set(threadContainer, item);
        }
        visualStack.splice(parentIndex + 1);
        visualStack.push({ left: visualLeft, item });
      }
    } catch {
      // Facebook can replace individual comment nodes while scanning.
    }
  }

  return resolveCommentRelationships(
    uniqueByFingerprint([...parsedByArticle.values()]),
    post,
  );
}

function findCommentThreadContainer(article, root) {
  let current = article.parentElement;
  while (current && current !== root) {
    if (current.matches?.('[data-virtualized="false"]')) {
      const firstArticle = current.querySelector('[role="article"]');
      if (firstArticle) {
        const firstScope = cloneWithoutNestedArticles(firstArticle);
        const firstRelation = extractCommentRelation(
          findCommentPermalink(firstScope),
        );
        if (firstRelation.commentId && !firstRelation.parentCommentId) {
          return current;
        }
      }
    }
    current = current.parentElement;
  }
  return null;
}

function getCommentVisualLeft(article) {
  const profileLinks = [...article.querySelectorAll('a[href]')].filter(
    (link) =>
      link.closest('[role="article"]') === article &&
      isVisible(link) &&
      isProfileUrl(link.getAttribute('href') || ''),
  );
  const lefts = profileLinks
    .map((link) => link.getBoundingClientRect().left)
    .filter(Number.isFinite);
  return lefts.length
    ? Math.min(...lefts)
    : article.getBoundingClientRect().left;
}

function resolveCommentRelationships(comments, post) {
  const byCommentId = new Map(
    comments
      .filter((comment) => comment.commentId)
      .map((comment) => [comment.commentId, comment]),
  );
  const resolved = new Set();
  const resolving = new Set();

  function resolve(comment) {
    if (resolved.has(comment) || resolving.has(comment)) return;
    resolving.add(comment);

    const parent = byCommentId.get(comment.parentCommentId);
    if (parent && parent !== comment) {
      resolve(parent);
      comment.parentFingerprint = parent.fingerprint;
      comment.depth = parent.depth + 1;
      comment.treePath = `${parent.treePath}|${comment.commentId}`;
      comment.contextTexts = [...parent.contextTexts, comment.text];
      comment.replyToAuthor = parent.authorName;
    } else {
      comment.parentCommentId = null;
      comment.parentFingerprint = post?.fingerprint || null;
      comment.depth = 1;
      comment.treePath = comment.commentId;
      comment.contextTexts = [
        ...(post?.text ? [post.text] : []),
        comment.text,
      ];
      comment.replyToAuthor = '';
    }

    resolving.delete(comment);
    resolved.add(comment);
  }

  for (const comment of comments) resolve(comment);
  return comments;
}

function refineFlattenedThreadParents(comments) {
  const precedingByThread = new Map();
  const carriedParentByThread = new Map();

  for (const comment of comments) {
    const relation = extractCommentRelation(comment.sourceUrl);
    const threadRootId = relation.parentCommentId;
    if (!threadRootId) continue;

    const preceding = precedingByThread.get(threadRootId) || [];
    const normalizedText = normalizeUiText(comment.text);
    const mentionedParent = [...preceding].reverse().find((candidate) => {
      const normalizedAuthor = normalizeUiText(candidate.authorName);
      return (
        normalizedAuthor &&
        (normalizedText === normalizedAuthor ||
          normalizedText.startsWith(`${normalizedAuthor} `))
      );
    });

    if (mentionedParent && mentionedParent.commentId !== threadRootId) {
      comment.parentCommentId = mentionedParent.commentId;
      carriedParentByThread.set(threadRootId, mentionedParent.commentId);
    } else if (
      !mentionedParent &&
      comment.parentCommentId === threadRootId &&
      carriedParentByThread.has(threadRootId)
    ) {
      comment.parentCommentId = carriedParentByThread.get(threadRootId);
    } else if (mentionedParent?.commentId === threadRootId) {
      comment.parentCommentId = threadRootId;
      carriedParentByThread.delete(threadRootId);
    }

    preceding.push(comment);
    precedingByThread.set(threadRootId, preceding);
  }

  return comments;
}

function articleBelongsToPost(article, expectedPostId, root) {
  const ownScope = cloneWithoutNestedArticles(article);
  const ownPermalink = findCommentPermalink(ownScope);
  if (ownPermalink) {
    return extractPostId(ownPermalink) === expectedPostId;
  }

  let current = article.parentElement;
  while (current) {
    if (current.matches?.('[role="article"]')) {
      const parentScope = cloneWithoutNestedArticles(current);
      const parentPermalink = findCommentPermalink(parentScope);
      if (parentPermalink) {
        return extractPostId(parentPermalink) === expectedPostId;
      }
    }
    current = current.parentElement;
  }

  return root instanceof Element && root.matches('[role="dialog"]');
}

function isDirectPostLink(value, normalizedPostUrl) {
  try {
    const url = new URL(value, location.origin);
    if (
      url.searchParams.has('comment_id') ||
      url.searchParams.has('reply_comment_id')
    ) {
      return false;
    }
    return normalizePostUrl(url.toString()) === normalizedPostUrl;
  } catch {
    return false;
  }
}

function parseCommentArticle(
  article,
  {
    parentFingerprint,
    postUrl,
    postId,
    postText,
    parentItem,
    precedingItems = [],
    threadRootItem,
  },
) {
  const ownScope = cloneWithoutNestedArticles(article);
  const author = findAuthor(ownScope);
  const text = extractCommentText(ownScope, author.name);

  if (!author.name || !text || !isUsefulContent(text)) return null;

  const commentUrl =
    findCommentPermalink(ownScope) ||
    postUrl;
  const relation = extractCommentRelation(commentUrl);
  if (
    threadRootItem?.commentId &&
    relation.parentCommentId &&
    relation.parentCommentId !== threadRootItem.commentId
  ) {
    return null;
  }
  const commentId =
    relation.commentId ||
    createLocalCommentId(postId, author, text);
  const directParentItem =
    findMentionedParentItem(relation, text, precedingItems) ||
    parentItem ||
    (relation.parentCommentId ? threadRootItem : null);
  const parentCommentId = chooseDirectParentCommentId(
    relation,
    directParentItem,
  );
  const depth = directParentItem ? directParentItem.depth + 1 : 1;
  const treePath = directParentItem?.treePath
    ? `${directParentItem.treePath}|${commentId}`
    : commentId;
  const contextTexts = [
    ...(directParentItem?.contextTexts || (postText ? [postText] : [])),
    text,
  ];

  return createItem({
    kind: 'COMMENT',
    author,
    text,
    sourceUrl: commentUrl,
    parentFingerprint: directParentItem?.fingerprint || parentFingerprint,
    postId,
    commentId,
    parentCommentId,
    depth,
    treePath,
    contextTexts,
    replyToAuthor: directParentItem?.authorName || '',
  });
}

function findMentionedParentItem(relation, text, precedingItems) {
  if (!relation.parentCommentId) return null;

  const normalizedText = normalizeUiText(text);
  const rootItem =
    precedingItems.find(
      (candidate) => candidate.commentId === relation.parentCommentId,
    ) || null;
  const threadItems = precedingItems.filter((candidate) => {
    const threadRootId = candidate.treePath?.split('|')[0] || '';
    return (
      candidate.commentId === relation.parentCommentId ||
      threadRootId === relation.parentCommentId
    );
  });

  // A Facebook reply permalink identifies only the thread root. The visible
  // leading mention identifies the direct parent when replies are nested.
  const mentionedCandidates = threadItems.filter((candidate) => {
    const normalizedAuthor = normalizeUiText(candidate.authorName);
    return (
      normalizedAuthor &&
      (normalizedText === normalizedAuthor ||
        normalizedText.startsWith(`${normalizedAuthor} `))
    );
  });
  if (mentionedCandidates.length) {
    return mentionedCandidates[mentionedCandidates.length - 1];
  }

  // Without a leading mention, only the first reply can be assigned safely.
  // Deeper placement is left to the DOM indentation fallback.
  if (threadItems.length === 1) return rootItem;

  for (let index = precedingItems.length - 1; index >= 0; index -= 1) {
    const candidate = precedingItems[index];
    const threadRootId = candidate.treePath?.split('|')[0] || '';
    if (
      candidate.commentId !== relation.parentCommentId &&
      threadRootId !== relation.parentCommentId
    ) {
      continue;
    }

    const normalizedAuthor = normalizeUiText(candidate.authorName);
    if (
      normalizedAuthor &&
      (normalizedText === normalizedAuthor ||
        normalizedText.startsWith(`${normalizedAuthor} `))
    ) {
      return candidate;
    }
  }
  return null;
}

function chooseDirectParentCommentId(relation, parentItem) {
  if (!relation.parentCommentId) return null;

  const parentThreadRootId = parentItem?.treePath?.split('|')[0] || '';
  const isParentInUrlThread =
    parentItem &&
    (parentItem.commentId === relation.parentCommentId ||
      parentThreadRootId === relation.parentCommentId);
  return (
    (isParentInUrlThread ? parentItem.commentId : relation.parentCommentId) ||
    null
  );
}

function createItem({
  kind,
  author,
  text,
  sourceUrl,
  parentFingerprint,
  postId,
  commentId,
  parentCommentId,
  depth,
  treePath,
  contextTexts,
  replyToAuthor = '',
}) {
  const capturedAt = new Date().toISOString();
  const sourceUrlValue = cleanFacebookUrl(sourceUrl);
  const fingerprint = hash(
    [
      kind,
      sourceUrlValue,
      cleanFacebookUrl(author.url) || author.name,
      text.slice(0, 500),
    ].join('|'),
  );
  return {
    parserVersion: 21,
    kind,
    source: 'FACEBOOK_GROUP',
    groupUrl: getGroupUrl(),
    pageUrl: getCanonicalPostUrl(),
    sourceUrl: sourceUrlValue,
    parentFingerprint,
    postId:
      postId ||
      extractPostId(getCanonicalPostUrl()),
    commentId,
    parentCommentId,
    depth,
    treePath,
    contextTexts,
    replyToAuthor,
    authorName: author.name,
    authorUrl: cleanFacebookUrl(author.url),
    text,
    capturedAt,
    fingerprint,
  };
}

function findParentCommentArticle(article, root) {
  let current = article.parentElement;
  while (current && current !== root) {
    if (current.matches?.('[role="article"]')) return current;
    current = current.parentElement;
  }
  return null;
}

function extractPostId(value) {
  try {
    const url = new URL(value, location.origin);
    const match = url.pathname.match(
      /\/groups\/[^/]+\/(?:posts|permalink)\/(\d+)/,
    );
    return match?.[1] || hash(normalizePostUrl(value));
  } catch {
    return hash(String(value || 'unknown-post'));
  }
}

function extractCommentId(value) {
  return extractCommentRelation(value).commentId;
}

function extractCommentRelation(value) {
  try {
    const url = new URL(value, location.origin);
    const parentCommentId = url.searchParams.get('comment_id') || '';
    const replyCommentId = url.searchParams.get('reply_comment_id') || '';
    return {
      commentId: replyCommentId || parentCommentId,
      parentCommentId: replyCommentId ? parentCommentId : '',
    };
  } catch {
    return { commentId: '', parentCommentId: '' };
  }
}

function createLocalCommentId(postId, author, text) {
  return `local-${hash(
    [postId, cleanFacebookUrl(author.url) || author.name, text].join('|'),
  ).replace('fnv1a-', '')}`;
}

function extractCommentText(scope, authorName) {
  const preferred = [
    ...scope.querySelectorAll('[dir="auto"]'),
  ]
    .filter((node) => !node.closest('a, button, [role="button"]'))
    .map((node) => cleanText(node.innerText))
    .filter((text) => isUsefulContent(text))
    .filter((text) => text !== authorName)
    .filter((text) => !isMetadataText(text));

  return preferred.sort((a, b) => b.length - a.length)[0] || '';
}

function findAuthor(container, options = {}) {
  const anonymousName = [...container.querySelectorAll('strong, [dir="auto"]')]
    .map((node) => cleanText(node.innerText || node.textContent))
    .find((name) =>
      /^(nguoi tham gia an danh|anonymous participant)\b/.test(
        normalizeUiText(name),
      ),
    );
  if (anonymousName) {
    return { name: anonymousName, url: '' };
  }

  const candidates = [...container.querySelectorAll('a[href]')]
    .map((link) => ({
      link,
      href: link.getAttribute('href') || '',
      name: getLinkLabel(link, container),
    }))
    .filter(
      ({ href, name }) =>
        isProfileUrl(href) &&
        name.length >= 2 &&
        name.length <= 100 &&
        !isInterfaceText(name),
    )
    .sort(
      (a, b) =>
        scoreAuthorCandidate(b, options) -
        scoreAuthorCandidate(a, options),
    );

  return {
    name: candidates[0]?.name || '',
    url: candidates[0]?.href || '',
  };
}

function getLinkLabel(link, boundary) {
  const visibleText = cleanText(link.innerText || link.textContent);
  if (visibleText && !isMetadataText(visibleText)) return visibleText;

  const imageName = extractPersonName(
    link.querySelector('img')?.getAttribute('alt'),
  );
  if (imageName) return imageName;

  const ariaName = extractPersonName(link.getAttribute('aria-label'));
  if (ariaName) return ariaName;

  return findNearbyAuthorName(link, boundary);
}

function extractPersonName(value) {
  const label = cleanText(value);
  if (!label) return '';

  for (const pattern of [
    /^ảnh đại diện của (.+)$/i,
    /^ảnh của (.+)$/i,
    /^(.+?)(?:'s|’s) profile picture$/i,
    /^profile picture of (.+)$/i,
    /^(.+?) profile picture$/i,
  ]) {
    const match = label.match(pattern);
    if (match?.[1]) return cleanText(match[1]);
  }

  if (
    !/ảnh đại diện|profile picture|photo|avatar/i.test(label) &&
    label.length <= 100
  ) {
    return label;
  }
  return '';
}

function findNearbyAuthorName(link, boundary) {
  let current = link.parentElement;
  for (let depth = 0; current && current !== boundary && depth < 6; depth += 1) {
    const names = [...current.querySelectorAll('a[href] strong, a[href] [dir="auto"]')]
      .map((node) => cleanText(node.textContent))
      .filter(
        (name) =>
          name.length >= 2 &&
          name.length <= 100 &&
          !isInterfaceText(name) &&
          !isMetadataText(name),
      );
    if (names.length) return names[0];
    current = current.parentElement;
  }
  return '';
}

function scoreAuthorCandidate(candidate, options) {
  let score = 0;
  if (candidate.link.querySelector('img')) score += 8;
  if (candidate.link.querySelector('strong')) score += 6;
  if (candidate.link.closest('h2, h3, h4')) score += options.preferHeader ? 8 : 3;
  if (candidate.href.includes('/user/')) score += 5;
  if (candidate.href.includes('profile.php')) score += 4;
  if (!candidate.href.includes('/groups/')) score += 2;
  return score;
}

function findCommentPermalink(container) {
  if (!container?.querySelectorAll) return '';
  const link = [
    ...container.querySelectorAll(
      'a[href*="comment_id="], a[href*="reply_comment_id="]',
    ),
  ][0];
  return link?.getAttribute('href') || '';
}

function getCanonicalPostUrl() {
  const current = new URL(location.href);
  current.search = '';
  current.hash = '';

  const permalinkMatch = current.pathname.match(
    /^\/groups\/([^/]+)\/permalink\/(\d+)/,
  );
  if (permalinkMatch) {
    return `https://www.facebook.com/groups/${permalinkMatch[1]}/permalink/${permalinkMatch[2]}/`;
  }

  const postMatch = current.pathname.match(
    /^\/groups\/([^/]+)\/posts\/(\d+)/,
  );
  if (postMatch) {
    return `https://www.facebook.com/groups/${postMatch[1]}/posts/${postMatch[2]}/`;
  }

  return current.toString();
}

function getGroupUrl() {
  const match = location.pathname.match(/^\/groups\/([^/]+)/);
  return match
    ? `https://www.facebook.com/groups/${match[1]}/`
    : location.origin;
}

function findCommentExpanders() {
  const root = getPostRoot();
  return uniqueNodes(
    [...root.querySelectorAll('[role="button"], button')].filter((node) => {
      const text = cleanText(
        node.innerText ||
          node.getAttribute('aria-label') ||
          node.textContent,
      );
      return (
        isVisible(node) &&
        node.dataset.daoEduScannerClicked !== 'true' &&
        isCommentExpanderText(text)
      );
    }),
  );
}

function isCommentExpanderText(text) {
  if (EXPAND_TEXT_PATTERNS.some((pattern) => pattern.test(text))) return true;

  const normalized = normalizeUiText(text);
  return (
    /^xem (them |tat ca )?\d* ?binh luan$/.test(normalized) ||
    /^xem cac binh luan truoc$/.test(normalized) ||
    /^xem (them |tat ca )?\d* ?phan hoi$/.test(normalized) ||
    /^view (more|all \d+) comments$/.test(normalized) ||
    /^view (more|\d+) replies$/.test(normalized)
  );
}

function findCommentsScrollContainer() {
  const root = getPostRoot();
  let current = root instanceof Element ? root : document.documentElement;

  while (current instanceof Element && current !== document.body) {
    const style = window.getComputedStyle(current);
    const canScroll =
      /(auto|scroll)/.test(style.overflowY) &&
      current.scrollHeight > current.clientHeight + 100;
    if (canScroll) return current;
    current = current.parentElement;
  }

  const candidates = [...root.querySelectorAll('div')].filter((node) => {
    const style = window.getComputedStyle(node);
    return (
      /(auto|scroll)/.test(style.overflowY) &&
      node.scrollHeight > node.clientHeight + 100
    );
  });

  return candidates.sort(
    (a, b) => b.scrollHeight - a.scrollHeight,
  )[0] || null;
}

function normalizePostUrl(value) {
  try {
    const url = new URL(value, location.origin);
    const match = url.pathname.match(
      /\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)/,
    );
    if (match) {
      url.hostname = 'www.facebook.com';
      url.pathname = `/groups/${match[1]}/posts/${match[2]}/`;
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function cloneWithoutNestedArticles(container) {
  const clone = container.cloneNode(true);
  for (const nested of clone.querySelectorAll('[role="article"]')) {
    nested.remove();
  }
  return clone;
}

function isProfileUrl(href) {
  if (!href || href.startsWith('#')) return false;
  try {
    const url = new URL(href, location.origin);
    if (!url.hostname.endsWith('facebook.com')) return false;
    if (url.pathname === '/profile.php') return url.searchParams.has('id');
    if (url.pathname.includes('/user/')) return true;
    return /^\/(?!groups|watch|reel|photo|photos|permalink|story|share|help|settings|events|marketplace|gaming|notifications|messages|plugins)[^/?#]+\/?$/.test(
      url.pathname,
    );
  } catch {
    return false;
  }
}

function isUsefulContent(text) {
  return (
    text.length >= 2 &&
    text.length <= 10000 &&
    !isInterfaceText(text) &&
    !isMetadataText(text)
  );
}

function isInterfaceText(text) {
  return /^(thích|phản hồi|trả lời|chia sẻ|bình luận|xem thêm|theo dõi|like|reply|share|comment|follow)(\s|$)/i.test(
    text,
  );
}

function isMetadataText(text) {
  return (
    /^\d+\s*(phút|giờ|ngày|tuần|tháng|minute|hour|day|week|month)s?$/i.test(
      text,
    ) ||
    /^(tác giả|quản trị viên|người đóng góp hàng đầu)$/i.test(text)
  );
}

function isVisible(node) {
  if (!(node instanceof Element)) return false;
  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== 'hidden' &&
    style.display !== 'none'
  );
}

function cleanFacebookUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, location.origin);
    for (const key of [...url.searchParams.keys()]) {
      if (
        key.startsWith('__cft__') ||
        ['__tn__', 'mibextid', 'ref', 'refid', 'paipv'].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return '';
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeUiText(value) {
  return cleanText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function uniqueByFingerprint(items) {
  return [...new Map(items.map((item) => [item.fingerprint, item])).values()];
}

function uniqueNodes(nodes) {
  return [...new Set(nodes)];
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function hash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return `fnv1a-${(result >>> 0).toString(16)}`;
}
