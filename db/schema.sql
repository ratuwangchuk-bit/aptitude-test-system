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
