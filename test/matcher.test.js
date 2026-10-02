/* Node test for the pure matching logic: `node test/matcher.test.js`
   Stubs just enough of the browser so matcher.js can be loaded as-is. */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

global.self = globalThis;
global.CSS = { escape: (s) => s };

const load = (f) => {
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'));
};
load('store.js');
load('matcher.js');
const { JA } = global;

/** A minimal stand-in for a form control.
 *  `wrappingLabel` simulates `<label><input type="radio"> Yes</label>`, and `legend`
 *  simulates the enclosing fieldset that carries the actual question. */
function field({
  label = '',
  name = '',
  id = '',
  placeholder = '',
  autocomplete = '',
  automationId = '',
  type = 'text',
  wrappingLabel = '',
  legend = '',
  value = '',
}) {
  const attrs = { 'aria-label': label, autocomplete, 'data-automation-id': automationId, title: '' };
  return {
    type,
    name,
    id,
    placeholder,
    value,
    getAttribute: (k) => attrs[k] ?? null,
    closest: (sel) => {
      if (legend && /fieldset|group/.test(sel)) return { querySelector: () => ({ textContent: legend }) };
      if (wrappingLabel && /\blabel\b/.test(sel)) return { textContent: wrappingLabel };
      return null;
    },
    getRootNode: () => ({ querySelector: () => null }),
    parentElement: null,
  };
}

let failures = 0;
function expectKey(desc, descriptor, want) {
  const got = JA.classify(field(descriptor));
  const key = got && got.key;
  if (key !== want) {
    failures++;
    console.log(`  FAIL  ${desc}\n        want ${want}, got ${key} ${got ? `(matched ${got.why})` : ''}`);
  } else {
    console.log(`  ok    ${desc} → ${want}`);
  }
}

console.log('\nField classification');
// Greenhouse
expectKey('Greenhouse first name', { label: 'First Name *', id: 'first_name' }, 'firstName');
expectKey('Greenhouse last name', { label: 'Last Name *', id: 'last_name' }, 'lastName');
expectKey('Greenhouse email', { label: 'Email *', id: 'email' }, 'email');
expectKey('Greenhouse phone', { label: 'Phone', id: 'phone' }, 'phone');
expectKey('Greenhouse LinkedIn', { label: 'LinkedIn Profile', id: 'job_application_answers_attributes_0_text_value' }, 'linkedin');
expectKey('Greenhouse website', { label: 'Website', id: 'job_application_answers_attributes_1_text_value' }, 'portfolio');

// Lever
expectKey('Lever full name', { label: 'Full name✱', name: 'name' }, 'fullName');
expectKey('Lever current company', { label: 'Current company', name: 'org' }, 'currentCompany');
expectKey('Lever location', { label: 'Location (City)', name: 'location' }, 'city');

// Workday
expectKey('Workday legal first name', { automationId: 'legalNameSection_firstName' }, 'firstName');
expectKey('Workday legal last name', { automationId: 'legalNameSection_lastName' }, 'lastName');
expectKey('Workday address line 1', { automationId: 'addressSection_addressLine1' }, 'addressLine1');
expectKey('Workday city', { automationId: 'addressSection_city' }, 'city');
expectKey('Workday postal code', { automationId: 'addressSection_postalCode' }, 'postalCode');
expectKey('Workday country region', { automationId: 'addressSection_countryRegion' }, 'state');
expectKey('Workday phone number', { automationId: 'phone-number' }, 'phone');
expectKey('Workday phone country code', { automationId: 'country-phone-code' }, 'phoneCountryCode');
expectKey('Workday source', { label: 'How Did You Hear About Us?' }, 'howDidYouHear');

// Taleo / iCIMS / misc
expectKey('date of birth', { label: 'Date of Birth', placeholder: 'DD/MM/YYYY' }, 'dob');
expectKey('notice period', { label: 'What is your notice period?' }, 'noticePeriod');
expectKey('expected CTC', { label: 'Expected CTC (in LPA)' }, 'expectedSalary');
expectKey('current CTC', { label: 'Current CTC' }, 'currentSalary');
expectKey('years of experience', { label: 'Total years of relevant experience' }, 'yearsExperience');
expectKey('sponsorship', { label: 'Will you now or in the future require sponsorship for employment visa status?', type: 'radio' }, 'needsSponsorship');
expectKey('work authorization', { label: 'Are you legally authorized to work in the United States?', type: 'radio' }, 'authorizedToWork');
expectKey('relocation', { label: 'Are you willing to relocate?', type: 'radio' }, 'willingToRelocate');
expectKey('gender', { label: 'Gender' }, 'gender');
expectKey('veteran', { label: 'Veteran Status' }, 'veteranStatus');
expectKey('disability', { label: 'Disability Status' }, 'disabilityStatus');
expectKey('ethnicity', { label: 'Race / Ethnicity' }, 'ethnicity');
expectKey('university', { label: 'School or University' }, 'university');
expectKey('field of study', { label: 'Field of Study' }, 'fieldOfStudy');
expectKey('graduation year', { label: 'Year of Passing' }, 'gradYear');
expectKey('referral', { label: 'Were you referred by a current employee? If so, who referred you?' }, 'referredBy');
expectKey('preferred name beats first name', { label: 'Preferred First Name' }, 'preferredName');
expectKey('confirm email still maps to email', { label: 'Confirm Email Address' }, 'email');
expectKey('autocomplete-only field', { autocomplete: 'family-name', id: 'ln2' }, 'lastName');

console.log('\nRadio groups: classify on the group question, not the option label');
// Each radio's own label is just "Yes"/"No", so these only work via the fieldset legend.
expectKey(
  'relocation radio wrapped in a label',
  { type: 'radio', name: 'relo', value: 'yes', wrappingLabel: 'Yes', legend: 'Are you willing to relocate?' },
  'willingToRelocate'
);
expectKey(
  'sponsorship radio wrapped in a label',
  {
    type: 'radio',
    name: 'spon',
    value: 'no',
    wrappingLabel: 'No',
    legend: 'Will you now or in the future require sponsorship for an employment visa?',
  },
  'needsSponsorship'
);
expectKey(
  'work authorization radio wrapped in a label',
  {
    type: 'radio',
    name: 'auth',
    value: 'yes',
    wrappingLabel: 'Yes',
    legend: 'Are you legally authorized to work in the country of this role?',
  },
  'authorizedToWork'
);

console.log('\nFields that must NOT be touched');
function expectNoKey(desc, descriptor) {
  const got = JA.classify(field(descriptor));
  if (got) {
    failures++;
    console.log(`  FAIL  ${desc}\n        expected no match, got ${got.key} (matched ${got.why})`);
  } else {
    console.log(`  ok    ${desc} → ignored`);
  }
}
expectNoKey('search box', { label: 'Search jobs', name: 'q' });
expectNoKey('password', { label: 'Password', type: 'password' });
expectNoKey('emergency contact name', { label: 'Emergency Contact Name' });
expectNoKey('reference name', { label: 'Reference Name' });
expectNoKey('username', { label: 'Username' });
expectNoKey('role you are applying for', { label: 'Which role are you applying for?' });

console.log('\nSaved-answer matching');
const snippets = JA.DEFAULT_SNIPPETS;
const T = JA.DEFAULT_SETTINGS.snippetThreshold;
function expectSnippet(question, wantId) {
  const hit = JA.matchSnippet(question, snippets, T);
  const got = hit && hit.snippet.id;
  if (got !== wantId) {
    failures++;
    console.log(`  FAIL  "${question}"\n        want ${wantId}, got ${got}${hit ? ` (score ${hit.score})` : ''}`);
  } else {
    console.log(`  ok    "${question}" → ${wantId || 'no match'}${hit ? ` (score ${hit.score})` : ''}`);
  }
}
expectSnippet('Why do you want to work at Acme?', 'why-company');
expectSnippet('Why are you interested in this role?', 'why-company');
expectSnippet('Tell us about yourself', 'about-me');
expectSnippet('Describe the most challenging project you have worked on.', 'challenging-project');
expectSnippet('What are your salary expectations?', 'salary');
expectSnippet('What is your notice period?', 'notice');
expectSnippet('Please describe your current work authorization status.', 'visa');
expectSnippet('How did you hear about this opportunity?', 'how-heard');
expectSnippet('Cover letter', 'cover-letter');
expectSnippet('Is there anything else you would like us to know?', 'additional');
expectSnippet('Paste the output of your favourite shell command', null);
expectSnippet('What is 2 + 2?', null);

console.log('\nDate reformatting');
load('filler.js');
function expectDate(placeholder, type, want) {
  const got = JA.formatDate('1997-08-15', field({ placeholder, type }));
  if (got !== want) {
    failures++;
    console.log(`  FAIL  placeholder "${placeholder}" type ${type}\n        want ${want}, got ${got}`);
  } else {
    console.log(`  ok    placeholder "${placeholder}" type ${type} → ${got}`);
  }
}
expectDate('DD/MM/YYYY', 'text', '15/08/1997');
expectDate('MM/DD/YYYY', 'text', '08/15/1997');
expectDate('YYYY-MM-DD', 'text', '1997/08/15');
expectDate('', 'text', '08/15/1997'); // US-hosted ATS default
expectDate('', 'date', '1997-08-15'); // native date inputs want ISO

console.log(failures === 0 ? '\nAll matcher assertions passed.\n' : `\n${failures} assertion(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
