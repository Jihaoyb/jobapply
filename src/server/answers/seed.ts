/**
 * Work-authorization seed answers for the pilot applicant profile:
 * F-1 OPT, currently authorized to work in the US, will require H-1B sponsorship in future.
 * HUMAN REVIEW REQUIRED: every seed is stored with needs_review=true and listed in
 * docs/p2/answers.md. Confirm wording and answers before the first live application.
 */
const yesNo = ['Yes', 'No'];
export const profileSeedAnswers: {
  question: string;
  choices: string[];
  answer: string;
}[] = [
  {
    question: 'Are you legally authorized to work in the United States?',
    choices: yesNo,
    answer: 'Yes',
  },
  {
    question: 'Are you currently authorized to work in the United States?',
    choices: yesNo,
    answer: 'Yes',
  },
  {
    question:
      'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?',
    choices: yesNo,
    answer: 'Yes',
  },
  {
    question:
      'Will you in the future require sponsorship for employment visa status?',
    choices: yesNo,
    answer: 'Yes',
  },
  {
    question:
      'Do you currently require visa sponsorship to work in the United States?',
    choices: yesNo,
    answer: 'No',
  },
  {
    question:
      'Are you able to work in the United States without sponsorship now and in the future?',
    choices: yesNo,
    answer: 'No',
  },
  {
    question: 'Are you a U.S. citizen or lawful permanent resident?',
    choices: yesNo,
    answer: 'No',
  },
  {
    question: 'What is your current work authorization status?',
    choices: [],
    answer:
      'F-1 student with Optional Practical Training (OPT) employment authorization',
  },
];
