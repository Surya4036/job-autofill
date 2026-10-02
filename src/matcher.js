/* Field classification: given a form control, decide which profile key (if any) it wants,
   and for long-form questions, which saved snippet answers it. Pure string work, no DOM writes. */

var JA = (self.JA = self.JA || {}); // var, not const: content scripts share one global scope

/** Normalise an attribute or label into space-separated lowercase words.
 *  Splits camelCase first so Workday ids like `legalNameSection_firstName` become
 *  "legal name section first name". */
JA.words = function words(s) {
  return String(s == null ? '' : s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
};

const text = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');

/** The human-readable question for a control, preferring real labels.
 *  Used for snippet matching and for the fill report. */
JA.questionText = function questionText(el) {
  const root = el.getRootNode ? el.getRootNode() : document;
  const q = (sel) => {
    try {
      return root.querySelector(sel);
    } catch {
      return null;
    }
  };

  if (el.id) {
    const lbl = q(`label[for="${CSS.escape(el.id)}"]`);
    if (lbl) return text(lbl);
  }

  const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => q(`#${CSS.escape(id)}`))
      .filter(Boolean)
      .map(text);
    if (parts.length) return parts.join(' ');
  }

  const wrapping = el.closest && el.closest('label');
  if (wrapping) return text(wrapping);

  const aria = el.getAttribute && el.getAttribute('aria-label');
  if (aria) return aria.trim();

  // Radio/checkbox groups usually carry the question on a fieldset legend
  // or on a group container, not on the input itself.
  const group = el.closest && el.closest('fieldset,[role="group"],[role="radiogroup"]');
  if (group) {
    const legend = group.querySelector('legend,[role="heading"],.label,label');
    const t = text(legend);
    if (t && t.length < 400) return t;
  }

  // Last resort: the nearest ancestor whose text is short enough to be a label
  // rather than a whole page section.
  let node = el.parentElement;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const t = text(node);
    if (t && t.length <= 200) return t;
  }

  return el.placeholder || el.name || '';
};

/** The label for a single radio/checkbox option ("Yes", "No", "Prefer not to say"),
 *  as opposed to the question the group is asking. */
JA.optionLabel = function optionLabel(el) {
  const root = el.getRootNode ? el.getRootNode() : document;
  if (el.id) {
    try {
      const lbl = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return text(lbl);
    } catch {
      /* invalid id for a selector */
    }
  }
  const wrapping = el.closest && el.closest('label');
  if (wrapping) return text(wrapping);
  const aria = el.getAttribute && el.getAttribute('aria-label');
  if (aria) return aria.trim();
  return el.value || '';
};

/** The question a radio/checkbox group is asking.
 *  Needed because each radio's own label is just its option text — classifying on that
 *  would mean every Yes/No group looks like the word "Yes". */
JA.groupQuestion = function groupQuestion(el) {
  const group = el.closest && el.closest('fieldset,[role="group"],[role="radiogroup"]');
  if (group) {
    const legend = group.querySelector('legend,[role="heading"]');
    const t = text(legend);
    if (t && t.length <= 300) return t;
  }

  // No fieldset (common on Greenhouse/Lever, which use plain divs): climb until the
  // container holds all the sibling options, then subtract the option labels so only
  // the question text is left.
  if (!el.parentElement) return '';
  let container = el.parentElement;
  for (let depth = 0; container && depth < 6; depth++, container = container.parentElement) {
    let sibs;
    try {
      sibs = el.name
        ? container.querySelectorAll(`input[type="${el.type}"][name="${CSS.escape(el.name)}"]`)
        : container.querySelectorAll(`input[type="${el.type}"]`);
    } catch {
      continue;
    }
    if (sibs.length < 2) continue;
    let t = text(container);
    for (const sib of sibs) {
      const lbl = JA.optionLabel(sib);
      if (lbl) t = t.split(lbl).join(' ');
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (t && t.length <= 300) return t;
  }
  return '';
};

/** Everything we know about a control, as one normalised string to match rules against. */
JA.haystack = function haystack(el) {
  const isChoice = el.type === 'radio' || el.type === 'checkbox';
  const attrs = [
    isChoice ? JA.groupQuestion(el) : '',
    JA.questionText(el),
    el.getAttribute && el.getAttribute('aria-label'),
    el.placeholder,
    el.name,
    el.id,
    el.getAttribute && el.getAttribute('autocomplete'),
    el.getAttribute && el.getAttribute('title'),
    el.getAttribute && el.getAttribute('data-automation-id'), // Workday
    el.getAttribute && el.getAttribute('data-qa'),
    el.getAttribute && el.getAttribute('data-testid'),
  ];
  return JA.words(attrs.filter(Boolean).join(' '));
};

// Controls we never touch, whatever they look like.
JA.SKIP = [
  /\bsearch\b/,
  /\bpassword\b/,
  /\bcaptcha\b/,
  /\busername\b/,
  /\bsign in\b/,
  /\blog in\b/,
  /\bcoupon\b/,
  /\bpromo code\b/,
  /\bcredit card\b/,
  /\bcvv\b/,
  /\bnewsletter\b/,
];

const NOT_A_PERSON = /\b(company|employer|organisation|organization|school|university|college|institute|reference|emergency|supervisor|manager|recruiter|file|user|account|domain|project|product|pet|team)\b/;

/** rule(key, weight, anyPatterns, notPatterns, autocompleteTokens)
 *  Highest weight among matching rules wins, so specific phrases outrank generic words. */
const r = (key, weight, any, not = [], ac = []) => ({ key, weight, any, not, ac });

JA.RULES = [
  // --- names -------------------------------------------------------------
  r('preferredName', 14, [/\b(preferred|nick|chosen|known as|goes by) ?name\b/, /\bpreferred first name\b/]),
  r('firstName', 12, [/\b(first|given|fore) ?name\b/, /\bfname\b/], [], ['given-name']),
  r('lastName', 12, [/\b(last|family|sur) ?name\b/, /\blname\b/, /\bsurname\b/], [], ['family-name']),
  r('middleName', 12, [/\bmiddle ?(name|initial)\b/, /\bminitial\b/], [], ['additional-name']),
  r('fullName', 10, [/\b(full|legal|complete|candidate|applicant|your) ?name\b/], [NOT_A_PERSON], ['name']),
  r('fullName', 4, [/\bname\b/], [NOT_A_PERSON, /\b(first|last|given|family|middle|sur|preferred|nick|user|f|l) ?name\b/]),

  // --- contact -----------------------------------------------------------
  r('email', 11, [/\be ?mail\b/], [], ['email']),
  r('phoneCountryCode', 13, [/\b(country code|phone code|dial code|isd code)\b/]),
  r('phone', 10, [/\b(phone|mobile|cell|telephone|tel|contact number|whatsapp)\b/], [/\b(country code|dial code|extension|\bext\b)\b/], ['tel']),

  r('addressLine2', 13, [/\baddress (line )?2\b/, /\b(apartment|apt|suite|unit|floor)\b/], [], ['address-line2']),
  r('addressLine1', 10, [/\baddress (line )?1\b/, /\bstreet address\b/, /\bstreet\b/], [], ['address-line1']),
  r('addressLine1', 6, [/\baddress\b/], [/\b(e ?mail|ip|web|url|line 2|apartment|apt|suite)\b/], ['street-address']),
  r('city', 11, [/\b(city|town|locality)\b/], [], ['address-level2']),
  r('state', 11, [/\b(state|province|prefecture|region|county)\b/], [/\bstatement\b/, /\bunited states\b/], ['address-level1']),
  r('postalCode', 12, [/\b(zip|postal|post) ?code\b/, /\bpin ?code\b/, /\bzip\b/, /\bpostcode\b/], [], ['postal-code']),
  r('country', 10, [/\bcountry\b/], [/\b(code|dial)\b/], ['country', 'country-name']),

  // --- links -------------------------------------------------------------
  r('linkedin', 14, [/\blinked ?in\b/]),
  r('github', 14, [/\bgit ?hub\b/]),
  r('twitter', 14, [/\btwitter\b/, /\bx profile\b/]),
  r('portfolio', 10, [/\b(portfolio|personal (website|site)|personal url|blog|homepage)\b/]),
  r('portfolio', 5, [/\b(website|web site|url|link)\b/], [/\b(company|employer|job posting|linked ?in|git ?hub)\b/], ['url']),

  // --- current role ------------------------------------------------------
  r('currentCompany', 11, [/\b(current|present|most recent|latest) (company|employer|organisation|organization)\b/, /\bcompany name\b/, /\bemployer\b/]),
  r('currentCompany', 6, [/\b(company|organisation|organization)\b/], [/\b(why|about|website|size)\b/]),
  r('currentTitle', 11, [/\b(current|present|most recent) (job )?(title|position|role)\b/, /\bjob title\b/, /\bdesignation\b/]),
  r('currentTitle', 5, [/\b(title|position|role)\b/], [/\b(applying|applied|you are applying|interested in|desired|this (role|position))\b/]),
  r('yearsExperience', 13, [/\b(years|yrs) of (relevant |total |professional |work )?experience\b/, /\btotal experience\b/, /\bexperience in years\b/, /\bhow many years\b/]),
  r('currentSalary', 13, [/\bcurrent (salary|ctc|compensation|pay)\b/]),
  r('expectedSalary', 13, [/\b(expected|desired|target) (salary|ctc|compensation|pay)\b/, /\bsalary expectation/, /\bcompensation expectation/]),
  r('noticePeriod', 13, [/\bnotice period\b/]),
  r('earliestStartDate', 12, [/\b(earliest|possible) start\b/, /\bavailable start date\b/, /\bwhen can you (start|join)\b/, /\bstart date\b/, /\bavailability date\b/]),

  // --- education ---------------------------------------------------------
  r('gradYear', 13, [/\bgraduation (year|date)\b/, /\byear of (graduation|passing|completion)\b/, /\b(passing|completion) year\b/]),
  r('fieldOfStudy', 12, [/\bfield of study\b/, /\bmajor\b/, /\bdiscipline\b/, /\bspecial(isation|ization|ity)\b/, /\bbranch\b/, /\bstream\b/]),
  r('degree', 11, [/\bdegree\b/, /\bqualification\b/, /\beducation level\b/, /\blevel of education\b/]),
  r('university', 11, [/\b(university|college|school|institute|institution)\b/], [/\bschool district\b/]),
  r('gpa', 12, [/\b(gpa|cgpa)\b/, /\bgrade point\b/, /\bpercentage\b/, /\bmarks\b/]),

  // --- demographics / eligibility ---------------------------------------
  r('dob', 14, [/\bdate of birth\b/, /\bbirth ?date\b/, /\bdob\b/, /\bbirthday\b/], [], ['bday']),
  r('gender', 12, [/\bgender\b/, /\bsex\b/]),
  r('pronouns', 13, [/\bpronoun/]),
  r('nationality', 12, [/\bnationalit/, /\bcitizenship\b/, /\bcitizen of\b/]),
  r('needsSponsorship', 14, [/\bsponsor(ship)?\b/]),
  r('authorizedToWork', 13, [/\bauthori[sz]ed to work\b/, /\bwork authori[sz]ation\b/, /\bright to work\b/, /\b(legally )?eligible to work\b/, /\blegally permitted to work\b/]),
  r('willingToRelocate', 13, [/\brelocat/]),
  r('willingToTravel', 13, [/\b(willing|able|open) to travel\b/, /\btravel requirement/]),
  r('visaStatus', 12, [/\bvisa (status|type|category)\b/, /\bwork permit\b/, /\bimmigration status\b/, /\bvisa\b/]),
  r('previouslyEmployedHere', 13, [/\bpreviously (employed|worked|applied)\b/, /\bformer(ly)? employ/, /\bworked (here|for us|at this company) before\b/]),
  r('veteranStatus', 13, [/\bveteran\b/, /\bmilitary service\b/]),
  r('disabilityStatus', 13, [/\bdisab/]),
  r('ethnicity', 13, [/\bethnic/, /\brace\b/, /\bhispanic\b/, /\blatino\b/]),
  r('howDidYouHear', 13, [/\bhow did you (hear|find|learn)\b/, /\bwhere did you (hear|find)\b/, /\bsource of (application|referral)\b/, /\bhow were you referred\b/]),
  r('referredBy', 13, [/\breferr?ed by\b/, /\breferral (name|source|employee)\b/, /\bwho referred\b/, /\bemployee referral\b/]),
];

/** Best profile key for a control, or null. Returns { key, weight, why }. */
JA.classify = function classify(el) {
  const hay = JA.haystack(el);
  if (!hay) return null;
  if (JA.SKIP.some((re) => re.test(hay))) return null;

  const autocomplete = JA.words(el.getAttribute && el.getAttribute('autocomplete'));
  let best = null;

  for (const rule of JA.RULES) {
    if (rule.not.some((re) => re.test(hay))) continue;
    const hit = rule.any.find((re) => re.test(hay));
    const acHit = rule.ac.some((t) => autocomplete === t);
    if (!hit && !acHit) continue;
    const weight = rule.weight + (acHit ? 6 : 0);
    if (!best || weight > best.weight) best = { key: rule.key, weight, why: acHit ? `autocomplete=${autocomplete}` : String(hit) };
  }
  return best;
};

/** Best saved snippet for a free-text question. Returns { snippet, score } or null. */
JA.matchSnippet = function matchSnippet(questionText, snippets, threshold) {
  const q = JA.words(questionText);
  if (!q) return null;
  const qWords = new Set(q.split(' '));
  let best = null;

  for (const s of snippets) {
    if (!s.answer || !s.answer.trim()) continue;
    let score = 0;
    for (const raw of s.triggers || []) {
      const t = JA.words(raw);
      if (!t) continue;
      const parts = t.split(' ');
      if (parts.length > 1) {
        if (q.includes(t)) score += 3;
        else if (parts.every((w) => qWords.has(w))) score += 1.5;
      } else if (qWords.has(t)) {
        score += 1;
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { snippet: s, score };
  }

  return best && best.score >= threshold ? best : null;
};
