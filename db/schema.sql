CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    role VARCHAR(30) NOT NULL DEFAULT 'general_admin' CHECK (role IN ('super_admin', 'general_admin')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);


ALTER TABLE admins ADD COLUMN IF NOT EXISTS role VARCHAR(30) NOT NULL DEFAULT 'general_admin';
ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
DO $$ BEGIN
    ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('super_admin', 'general_admin'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS admin_sessions (
    id SERIAL PRIMARY KEY,
    admin_id INT REFERENCES admins(id) ON DELETE CASCADE,
    session_token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS passcodes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '90 minutes')
);

-- Remove old one-time-use column from earlier versions. Passcodes are reusable.
ALTER TABLE passcodes DROP COLUMN IF EXISTS is_used;
ALTER TABLE passcodes ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '90 minutes');


CREATE TABLE IF NOT EXISTS participants (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    cid_number VARCHAR(50) NOT NULL,
    company_name VARCHAR(150) NOT NULL,
    contact_number VARCHAR(50) NOT NULL,
    passcode_id INT REFERENCES passcodes(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- Ensure CID remains unique for all existing and future participants.
DO $$ BEGIN
    ALTER TABLE participants ADD CONSTRAINT participants_cid_number_unique UNIQUE (cid_number);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    section VARCHAR(50) NOT NULL DEFAULT 'Analytical Ability' CHECK (section IN ('Analytical Ability', 'Verbal Ability', 'Quantitative Skills')),
    question_text TEXT NOT NULL,
    option_a TEXT NOT NULL,
    option_b TEXT NOT NULL,
    option_c TEXT NOT NULL,
    option_d TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE questions ADD COLUMN IF NOT EXISTS section VARCHAR(50) NOT NULL DEFAULT 'Analytical Ability';
DO $$ BEGIN
    ALTER TABLE questions ADD CONSTRAINT questions_section_check CHECK (section IN ('Analytical Ability', 'Verbal Ability', 'Quantitative Skills'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS answers (
    id SERIAL PRIMARY KEY,
    question_id INT UNIQUE REFERENCES questions(id) ON DELETE CASCADE,
    correct_option CHAR(1) NOT NULL CHECK (correct_option IN ('A', 'B', 'C', 'D')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS submissions (
    id SERIAL PRIMARY KEY,
    participant_id INT REFERENCES participants(id) ON DELETE CASCADE,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    score INT DEFAULT 0,
    total_questions INT DEFAULT 0,
    analytical_score INT DEFAULT 0,
    verbal_score INT DEFAULT 0,
    quantitative_score INT DEFAULT 0,
    percentage NUMERIC(5,2) DEFAULT 0
);

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS analytical_score INT DEFAULT 0;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS verbal_score INT DEFAULT 0;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS quantitative_score INT DEFAULT 0;

CREATE TABLE IF NOT EXISTS participant_answers (
    id SERIAL PRIMARY KEY,
    submission_id INT REFERENCES submissions(id) ON DELETE CASCADE,
    question_id INT REFERENCES questions(id) ON DELETE CASCADE,
    selected_option CHAR(1) CHECK (selected_option IN ('A', 'B', 'C', 'D')),
    is_correct BOOLEAN DEFAULT FALSE
);

-- Default super admin username: admin password: admin123
INSERT INTO admins (username, password_hash, role, is_active)
VALUES ('admin', '$2a$10$jAf3YJPlTSPg0aVSjhlcdONGwEW5dM42Nh/URf6vCB5y.5Yc7/frW', 'super_admin', TRUE)
ON CONFLICT (username) DO UPDATE SET role='super_admin', is_active=TRUE;

-- Passcodes are not inserted manually in the schema.
-- Super admin must generate participant passcodes from the Passcodes page. Each passcode expires after 1 hour 30 minutes.

WITH seed_questions(section, question_text, option_a, option_b, option_c, option_d, correct_option) AS (
    VALUES
('Analytical Ability', 'What comes next in the series: 2, 4, 8, 16, ?', '18', '24', '32', '36', 'C'),
('Analytical Ability', 'Find the odd one out: triangle, square, circle, apple.', 'Triangle', 'Square', 'Circle', 'Apple', 'D'),
('Analytical Ability', 'If all roses are flowers, which statement is definitely true?', 'All flowers are roses', 'Roses are flowers', 'Some roses are not flowers', 'No roses are flowers', 'B'),
('Analytical Ability', 'Complete the pattern: A, C, F, J, ?', 'K', 'L', 'M', 'O', 'D'),
('Analytical Ability', 'Which number is the odd one out: 3, 6, 9, 11, 12?', '6', '9', '11', '12', 'C'),
('Analytical Ability', 'If MONDAY is coded as NPOEBZ, how is TUESDAY coded?', 'UVFTEBZ', 'UVFTEAY', 'TVDTEBZ', 'UWFTEBZ', 'A'),
('Analytical Ability', 'A clock shows 3:00. What is the angle between the hour and minute hand?', '45 degrees', '60 degrees', '90 degrees', '120 degrees', 'C'),
('Analytical Ability', 'Which figure has no straight line?', 'Triangle', 'Square', 'Rectangle', 'Circle', 'D'),
('Analytical Ability', 'If 5 people shake hands with each other once, how many handshakes happen?', '5', '10', '15', '20', 'B'),
('Analytical Ability', 'Book is to reading as fork is to ____.', 'Writing', 'Eating', 'Drawing', 'Sleeping', 'B'),
('Analytical Ability', 'Which comes next: 1, 1, 2, 3, 5, 8, ?', '11', '12', '13', '15', 'C'),
('Analytical Ability', 'If LEFT is opposite of RIGHT, then UP is opposite of ____.', 'Down', 'Side', 'Top', 'High', 'A'),
('Analytical Ability', 'Which word does not belong: red, blue, green, chair?', 'Red', 'Blue', 'Green', 'Chair', 'D'),
('Analytical Ability', 'A is taller than B. B is taller than C. Who is shortest?', 'A', 'B', 'C', 'Cannot say', 'C'),
('Analytical Ability', 'If today is Friday, what day will it be after 3 days?', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'B'),
('Verbal Ability', 'Choose the synonym of rapid.', 'Slow', 'Fast', 'Weak', 'Late', 'B'),
('Verbal Ability', 'Choose the antonym of honest.', 'Truthful', 'Sincere', 'Dishonest', 'Polite', 'C'),
('Verbal Ability', 'Select the correct spelling.', 'Accomodate', 'Acommodate', 'Accommodate', 'Acomodate', 'C'),
('Verbal Ability', 'Choose the synonym of begin.', 'Start', 'Stop', 'End', 'Close', 'A'),
('Verbal Ability', 'Choose the antonym of ancient.', 'Old', 'Modern', 'Historic', 'Past', 'B'),
('Verbal Ability', 'Fill in the blank: She is interested ____ learning Go.', 'on', 'at', 'in', 'for', 'C'),
('Verbal Ability', 'Choose the correct sentence.', 'He go to office', 'He goes to office', 'He going office', 'He gone office', 'B'),
('Verbal Ability', 'Choose the synonym of assist.', 'Help', 'Hide', 'Harm', 'Hold', 'A'),
('Verbal Ability', 'Choose the antonym of expand.', 'Increase', 'Grow', 'Reduce', 'Extend', 'C'),
('Verbal Ability', 'Which word is a noun?', 'Quickly', 'Beautiful', 'Company', 'Run', 'C'),
('Verbal Ability', 'Choose the correct plural of analysis.', 'Analysises', 'Analyses', 'Analysis', 'Analysed', 'B'),
('Verbal Ability', 'Fill in the blank: They have been working ____ morning.', 'since', 'for', 'at', 'to', 'A'),
('Verbal Ability', 'Choose the synonym of accurate.', 'Wrong', 'Exact', 'Late', 'Small', 'B'),
('Verbal Ability', 'Choose the antonym of difficult.', 'Hard', 'Simple', 'Complex', 'Tough', 'B'),
('Verbal Ability', 'Choose the correctly punctuated sentence.', 'Where are you going', 'Where are you going?', 'Where are you going.', 'Where are you going!', 'B'),
('Quantitative Skills', 'What is 10 + 5?', '10', '15', '20', '25', 'B'),
('Quantitative Skills', 'What is 25% of 200?', '25', '40', '50', '75', 'C'),
('Quantitative Skills', 'If 5x = 45, what is x?', '5', '9', '10', '15', 'B'),
('Quantitative Skills', 'What is 12 x 8?', '84', '90', '96', '108', 'C'),
('Quantitative Skills', 'What is 144 divided by 12?', '10', '11', '12', '14', 'C'),
('Quantitative Skills', 'What is the square root of 81?', '7', '8', '9', '10', 'C'),
('Quantitative Skills', 'A shop gives 10% discount on Nu. 500. What is the discount?', 'Nu. 25', 'Nu. 50', 'Nu. 75', 'Nu. 100', 'B'),
('Quantitative Skills', 'What is 3/4 as a percentage?', '25%', '50%', '75%', '100%', 'C'),
('Quantitative Skills', 'If a car travels 60 km in 1 hour, how far in 3 hours?', '120 km', '150 km', '180 km', '240 km', 'C'),
('Quantitative Skills', 'What is the average of 10, 20 and 30?', '15', '20', '25', '30', 'B'),
('Quantitative Skills', 'Solve: 7 + 6 x 2.', '19', '26', '20', '13', 'A'),
('Quantitative Skills', 'If 2 pens cost Nu. 30, what is the cost of 5 pens?', 'Nu. 60', 'Nu. 75', 'Nu. 90', 'Nu. 100', 'B'),
('Quantitative Skills', 'What is 15% of 300?', '30', '35', '45', '60', 'C'),
('Quantitative Skills', 'What is 9 squared?', '18', '72', '81', '90', 'C'),
('Quantitative Skills', 'A rectangle has length 10 and width 5. What is its area?', '15', '30', '50', '100', 'C')
)
INSERT INTO questions (section, question_text, option_a, option_b, option_c, option_d)
SELECT section, question_text, option_a, option_b, option_c, option_d
FROM seed_questions sq
WHERE NOT EXISTS (SELECT 1 FROM questions q WHERE q.question_text = sq.question_text);

WITH seed_answers(question_text, correct_option) AS (
    VALUES
('What comes next in the series: 2, 4, 8, 16, ?', 'C'),
('Find the odd one out: triangle, square, circle, apple.', 'D'),
('If all roses are flowers, which statement is definitely true?', 'B'),
('Complete the pattern: A, C, F, J, ?', 'D'),
('Which number is the odd one out: 3, 6, 9, 11, 12?', 'C'),
('If MONDAY is coded as NPOEBZ, how is TUESDAY coded?', 'A'),
('A clock shows 3:00. What is the angle between the hour and minute hand?', 'C'),
('Which figure has no straight line?', 'D'),
('If 5 people shake hands with each other once, how many handshakes happen?', 'B'),
('Book is to reading as fork is to ____.', 'B'),
('Which comes next: 1, 1, 2, 3, 5, 8, ?', 'C'),
('If LEFT is opposite of RIGHT, then UP is opposite of ____.', 'A'),
('Which word does not belong: red, blue, green, chair?', 'D'),
('A is taller than B. B is taller than C. Who is shortest?', 'C'),
('If today is Friday, what day will it be after 3 days?', 'B'),
('Choose the synonym of rapid.', 'B'),
('Choose the antonym of honest.', 'C'),
('Select the correct spelling.', 'C'),
('Choose the synonym of begin.', 'A'),
('Choose the antonym of ancient.', 'B'),
('Fill in the blank: She is interested ____ learning Go.', 'C'),
('Choose the correct sentence.', 'B'),
('Choose the synonym of assist.', 'A'),
('Choose the antonym of expand.', 'C'),
('Which word is a noun?', 'C'),
('Choose the correct plural of analysis.', 'B'),
('Fill in the blank: They have been working ____ morning.', 'A'),
('Choose the synonym of accurate.', 'B'),
('Choose the antonym of difficult.', 'B'),
('Choose the correctly punctuated sentence.', 'B'),
('What is 10 + 5?', 'B'),
('What is 25% of 200?', 'C'),
('If 5x = 45, what is x?', 'B'),
('What is 12 x 8?', 'C'),
('What is 144 divided by 12?', 'C'),
('What is the square root of 81?', 'C'),
('A shop gives 10% discount on Nu. 500. What is the discount?', 'B'),
('What is 3/4 as a percentage?', 'C'),
('If a car travels 60 km in 1 hour, how far in 3 hours?', 'C'),
('What is the average of 10, 20 and 30?', 'B'),
('Solve: 7 + 6 x 2.', 'A'),
('If 2 pens cost Nu. 30, what is the cost of 5 pens?', 'B'),
('What is 15% of 300?', 'C'),
('What is 9 squared?', 'C'),
('A rectangle has length 10 and width 5. What is its area?', 'C')
)
INSERT INTO answers (question_id, correct_option)
SELECT q.id, sa.correct_option
FROM seed_answers sa
JOIN questions q ON q.question_text = sa.question_text
WHERE NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id = q.id);
