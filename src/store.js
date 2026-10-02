/* Profile + snippet storage. Shared by content script, popup and options page.
   Everything lives in chrome.storage.local — no network calls anywhere in this extension. */

const JA = (self.JA = self.JA || {});

// Field groups drive both the options UI and the autofill matcher.
JA.SCHEMA = [
  {
    group: 'Personal',
    fields: [
      { key: 'firstName', label: 'First name' },
      { key: 'middleName', label: 'Middle name' },
      { key: 'lastName', label: 'Last name' },
      { key: 'fullName', label: 'Full name' },
      { key: 'preferredName', label: 'Preferred name' },
      { key: 'dob', label: 'Date of birth', type: 'date', hint: 'Stored as YYYY-MM-DD; reformatted per form.' },
      { key: 'gender', label: 'Gender' },
      { key: 'pronouns', label: 'Pronouns' },
      { key: 'nationality', label: 'Nationality' },
    ],
  },
  {
    group: 'Contact',
    fields: [
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'phone', label: 'Phone', hint: 'Full international form, e.g. +91 7013111057' },
      { key: 'phoneCountryCode', label: 'Phone country code' },
      { key: 'phoneNational', label: 'Phone without country code' },
      { key: 'addressLine1', label: 'Address line 1' },
      { key: 'addressLine2', label: 'Address line 2' },
      { key: 'city', label: 'City' },
      { key: 'state', label: 'State / province' },
      { key: 'postalCode', label: 'Postal code' },
      { key: 'country', label: 'Country' },
    ],
  },
  {
    group: 'Links',
    fields: [
      { key: 'linkedin', label: 'LinkedIn URL' },
      { key: 'github', label: 'GitHub URL' },
      { key: 'portfolio', label: 'Portfolio / website' },
      { key: 'twitter', label: 'X / Twitter' },
    ],
  },
  {
    group: 'Current role',
    fields: [
      { key: 'currentCompany', label: 'Current company' },
      { key: 'currentTitle', label: 'Current job title' },
      { key: 'yearsExperience', label: 'Years of experience' },
      { key: 'currentSalary', label: 'Current salary' },
      { key: 'expectedSalary', label: 'Expected salary' },
      { key: 'noticePeriod', label: 'Notice period' },
      { key: 'earliestStartDate', label: 'Earliest start date' },
    ],
  },
  {
    group: 'Education',
    fields: [
      { key: 'degree', label: 'Highest degree' },
      { key: 'fieldOfStudy', label: 'Field of study / major' },
      { key: 'university', label: 'University / school' },
      { key: 'gradYear', label: 'Graduation year' },
      { key: 'gpa', label: 'GPA / percentage' },
    ],
  },
  {
    group: 'Eligibility',
    fields: [
      { key: 'authorizedToWork', label: 'Authorized to work?', type: 'yesno' },
      { key: 'needsSponsorship', label: 'Needs visa sponsorship?', type: 'yesno' },
      { key: 'willingToRelocate', label: 'Willing to relocate?', type: 'yesno' },
      { key: 'willingToTravel', label: 'Willing to travel?', type: 'yesno' },
      { key: 'visaStatus', label: 'Current visa / work permit status' },
      { key: 'previouslyEmployedHere', label: 'Previously employed by this company?', type: 'yesno' },
      { key: 'veteranStatus', label: 'Veteran status' },
      { key: 'disabilityStatus', label: 'Disability status' },
      { key: 'ethnicity', label: 'Race / ethnicity' },
      { key: 'howDidYouHear', label: 'How did you hear about us?' },
      { key: 'referredBy', label: 'Referred by' },
    ],
  },
];

JA.PROFILE_KEYS = JA.SCHEMA.flatMap((g) => g.fields.map((f) => f.key));

JA.fieldMeta = (key) => {
  for (const g of JA.SCHEMA) {
    const f = g.fields.find((x) => x.key === key);
    if (f) return f;
  }
  return null;
};

// Seeded from resume-v2-backend.md so the extension is useful on install.
// Edit anything on the options page.
JA.DEFAULT_PROFILE = {
  firstName: 'Surya',
  middleName: '',
  lastName: 'Prakash',
  fullName: 'Surya Prakash',
  preferredName: 'Surya',
  dob: '',
  gender: '',
  pronouns: '',
  nationality: 'Indian',

  email: 'Surya4036@gmail.com',
  phone: '+91 7013111057',
  phoneCountryCode: '+91',
  phoneNational: '7013111057',
  addressLine1: '',
  addressLine2: '',
  city: 'Hyderabad',
  state: 'Telangana',
  postalCode: '',
  country: 'India',

  linkedin: '',
  github: '',
  portfolio: '',
  twitter: '',

  currentCompany: 'Tata Consultancy Services',
  currentTitle: 'Software Engineer',
  yearsExperience: '5',
  currentSalary: '',
  expectedSalary: '',
  noticePeriod: '2 months',
  earliestStartDate: '',

  degree: '',
  fieldOfStudy: '',
  university: '',
  gradYear: '',
  gpa: '',

  authorizedToWork: 'Yes',
  needsSponsorship: 'Yes',
  willingToRelocate: 'Yes',
  willingToTravel: 'Yes',
  visaStatus: '',
  previouslyEmployedHere: 'No',
  veteranStatus: '',
  disabilityStatus: '',
  ethnicity: '',
  howDidYouHear: 'Company careers page',
  referredBy: '',
};

// Reusable answers for the long-form questions that keep recurring.
// `triggers` are matched against the form's question text. Multi-word triggers
// count as phrases and score much higher than single keywords.
JA.DEFAULT_SNIPPETS = [
  {
    id: 'why-company',
    label: 'Why this company / role',
    triggers: ['why do you want to work', 'why this company', 'why are you interested', 'why us', 'interest in this role', 'what attracts you'],
    answer:
      "I want to work on systems where backend engineering meets applied LLM work, and this role sits exactly there. I've spent five years building and running production Java and Python services for enterprise insurance platforms, including a legacy-to-modern migration I owned end to end, so I'm comfortable with the reliability and correctness side. More recently I've been building retrieval and agentic tooling on my own time, and I'd rather do that work somewhere the output is actually used at scale than keep it as side projects.",
  },
  {
    id: 'why-leaving',
    label: 'Why are you looking for a new role',
    triggers: ['why are you looking', 'why are you leaving', 'reason for change', 'reason for leaving', 'looking to move'],
    answer:
      "I've had strong ownership at TCS — production releases, a full migration, direct stakeholder work on-site in Japan — but the work is largely maintenance of established platforms. I'm looking for a role where I'm building LLM-backed systems as the core product rather than alongside it, with a team I can learn that depth from.",
  },
  {
    id: 'about-me',
    label: 'Tell us about yourself / summary',
    triggers: ['tell us about yourself', 'tell me about yourself', 'about yourself', 'brief introduction', 'professional summary', 'describe yourself'],
    answer:
      'Backend engineer with 5 years at TCS building Java and Python systems for large-scale enterprise insurance platforms, currently on-site in Japan working directly with customer stakeholders. I owned a Pro*C-on-Hitachi to RHEL migration end to end — database objects, cutover, production validation — and built Python static-analysis tooling that replaced weeks of manual review across 58,000+ mainframe programs. Day to day I work across REST APIs, SQL and schema design, production incident response, and AWS/Docker/Kubernetes deployment.',
  },
  {
    id: 'challenging-project',
    label: 'Most challenging project',
    triggers: ['challenging project', 'difficult project', 'proud of', 'describe a project', 'most significant', 'technical challenge', 'biggest accomplishment'],
    answer:
      'Migrating legacy Pro*C components from a Hitachi server to RHEL. The hard part was not the port itself but the unknown surface area: there was no reliable dependency map, so I wrote Python tooling to statically analyse the codebase and derive the call and data dependencies before touching anything. That let me scope the migration honestly, move the database objects in the right order, and validate against production behaviour after cutover rather than hoping. The same tooling later replaced weeks of manual review across 58,000+ mainframe programs.',
  },
  {
    id: 'strengths',
    label: 'Strengths',
    triggers: ['greatest strength', 'your strengths', 'what are your strengths', 'best qualities'],
    answer:
      "I'm good at making undocumented systems legible before I change them — writing tooling to map dependencies rather than reading code file by file. It's slower on day one and much faster by week two, and it means my migrations and refactors don't surprise anyone in production.",
  },
  {
    id: 'weakness',
    label: 'Weakness / area to improve',
    triggers: ['greatest weakness', 'your weakness', 'area for improvement', 'area you want to improve', 'development area'],
    answer:
      "I've historically gone deep on backend correctness and under-invested in making my work visible — I'd finish a migration and move on without writing it up. I've been fixing that deliberately: runbooks for the systems I own, and written design notes before I start rather than after.",
  },
  {
    id: 'salary',
    label: 'Salary expectations',
    triggers: ['salary expectation', 'expected compensation', 'compensation expectation', 'desired salary', 'expected ctc', 'what are your salary'],
    answer:
      "I'm flexible and would rather align on the role and level first. If you can share the band for this position I'll tell you straight away whether it works.",
  },
  {
    id: 'notice',
    label: 'Notice period / availability',
    triggers: ['notice period', 'when can you start', 'earliest start', 'availability to start', 'how soon can you join', 'start date'],
    answer: 'My notice period is 2 months, and I can start immediately after that. I can look at accelerating it if the start date matters.',
  },
  {
    id: 'visa',
    label: 'Work authorization / visa detail',
    triggers: ['work authorization', 'visa status', 'require sponsorship', 'need sponsorship', 'right to work', 'immigration status', 'eligible to work'],
    answer:
      "I'm an Indian national, currently on an employment visa for an on-site assignment in Japan. I would need sponsorship for roles outside India, and I'm happy to work through whatever the process looks like on your side.",
  },
  {
    id: 'relocation',
    label: 'Relocation',
    triggers: ['willing to relocate', 'open to relocation', 'relocate for this role', 'location preference'],
    answer: "Yes — I'm already working on-site abroad, so relocation is something I've done and I'm open to it again.",
  },
  {
    id: 'how-heard',
    label: 'How did you hear about us',
    triggers: ['how did you hear', 'how did you find', 'where did you hear', 'source of application'],
    answer: 'Through your careers page while researching teams working on applied LLM systems.',
  },
  {
    id: 'additional',
    label: 'Anything else / additional information',
    triggers: ['anything else', 'additional information', 'anything you would like to add', 'other information', 'additional comments'],
    answer:
      "One thing my resume understates: most of my LLM and infrastructure skills — retrieval pipelines, Kubernetes on EKS, Jenkins CI/CD, Prometheus and Grafana — are self-taught through projects I built rather than assigned work. Happy to walk through any of them in detail.",
  },
  {
    id: 'cover-letter',
    label: 'Cover letter',
    triggers: ['cover letter', 'covering letter', 'letter of motivation', 'motivation letter'],
    answer:
      "Hello,\n\nI'm applying because this role puts backend engineering and applied LLM work in the same job, which is the move I've been building toward.\n\nFor the past five years at TCS I've built and run Java and Python systems for large-scale enterprise insurance platforms, currently on-site in Japan working directly with customer stakeholders. I owned a legacy Pro*C-to-RHEL migration end to end, including database objects, cutover and production validation, and I wrote the Python static-analysis tooling that made it scopeable — the same tooling later replaced weeks of manual review across 58,000+ mainframe programs. That work is where I learned to care about correctness in systems nobody fully documents.\n\nAlongside that I've been building retrieval and agentic systems on my own time, and running them properly — Docker, Kubernetes on EKS, CI/CD, Prometheus and Grafana — because I wanted to understand the operational side rather than just the model calls.\n\nI'd welcome the chance to talk about where I could contribute.\n\nSurya Prakash",
  },
];

JA.DEFAULT_SETTINGS = {
  overwriteExisting: false,
  useSnippets: true,
  highlightFilled: true,
  snippetThreshold: 2.0,
};

JA.load = async function load() {
  const raw = await chrome.storage.local.get(['profile', 'snippets', 'settings']);
  return {
    profile: { ...JA.DEFAULT_PROFILE, ...(raw.profile || {}) },
    snippets: raw.snippets || JA.DEFAULT_SNIPPETS,
    settings: { ...JA.DEFAULT_SETTINGS, ...(raw.settings || {}) },
  };
};

JA.save = (patch) => chrome.storage.local.set(patch);
