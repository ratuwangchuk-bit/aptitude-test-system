# Digital Aptitude Evaluation System

A complete MCQ-based aptitude test system with random question selection, three test sections, hidden participant scores, and a section-wise admin result dashboard.

## Technology Used

- Frontend: HTML, Tailwind CSS, JavaScript
- Backend: Go, RESTful API, Gorilla Mux
- Database: PostgreSQL
- Session: Cookie-based admin login session
- Tool: VS Code

## Important: Why VS Code Asked for Password

The message below is not caused by the project code:

```text
[sudo] password for vscode:
```

It appears because the terminal command used `sudo`, for example:

```bash
sudo -u postgres psql
```

In GitHub Codespaces or cloud VS Code, you may not know the sudo password. This project has been updated so the app itself does not require sudo. You only need a running PostgreSQL database and correct database details in the `.env` file.

If localhost PostgreSQL does not work, use Neon, Supabase, Render PostgreSQL, or your local PostgreSQL installed on your laptop.

## Main Features

### Participant Side

- Reusable passcode verification
- Participant registration with required field validation
- Duplicate CID blocking so no two participants can share the same CID
- Test instruction page
- 60-minute countdown timer
- 45 random MCQ questions for each participant
- Three sections: Section A Analytical Ability, Section B Verbal Ability, Section C Quantitative Skills
- Manual test submission
- Auto submission when timer ends
- After submission, participant only sees a thank-you message; scores are not shown to users

### Admin Side

- Secure admin login
- Cookie-based session management
- Dashboard summary
- Random reusable passcode generation from admin dashboard
- Participant result list in section-wise format
- Total score out of 45
- Analytical, Verbal and Quantitative section scores out of 15 each
- Ranking based on total score
- Question management
- Answer management
- Excel upload for questions
- Excel upload for answers
- Downloadable Excel templates for each test section
- Modern dashboard with section performance and score distribution graphs

## Default Login and Passcodes

Admin login:

```text
Username: admin
Password: admin123
```

Sample passcodes:

```text
DAES-DEMO
TEST-001
TEST-002
TEST-003
TEST-004
TEST-005
```

Passcodes are reusable. Admin can generate a random passcode from the dashboard, and the same passcode can be used by multiple participants.

---

## Updated Question Bank Rules

The test is divided into three sections:

```text
Section A: Analytical Ability
Section B: Verbal Ability
Section C: Quantitative Skills
```

Each participant receives up to 45 random questions:

```text
15 random questions from Analytical Ability
15 random questions from Verbal Ability
15 random questions from Quantitative Skills
```

For this to work correctly, the question bank should contain at least 15 questions in each section. If any section has fewer than 15 questions, the system will show only the available questions from that section.

Question Excel upload supports this recommended format:

```text
section | question_text | option_a | option_b | option_c | option_d
```

The section value should be one of:

```text
Analytical Ability
Verbal Ability
Quantitative Skills
```

After participant submission, scores are saved in the database but are not displayed to participants. The participant will only see a thank-you message.


# Setup Option A: Local PostgreSQL on Your Laptop

Use this option if you have PostgreSQL installed locally.

## Step 1: Create Database

Open pgAdmin or PostgreSQL terminal and create a database named:

```sql
CREATE DATABASE aptitude_db;
```

## Step 2: Create Tables

From the project root folder, run:

```bash
psql -h localhost -U postgres -d aptitude_db -f db/schema.sql
```

Password should match your PostgreSQL password.

If your password is not `postgres`, update `.env`.

## Step 3: Check `.env`

The project includes a `.env` file:

```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=aptitude_db
DB_SSLMODE=disable
PORT=8080
SESSION_SECURE=false
```

Change `DB_PASSWORD` if your PostgreSQL password is different.

---

# Setup Option B: Online PostgreSQL Database

Use this option if localhost is giving this error:

```text
ECONNREFUSED 127.0.0.1:5432
```

That error means PostgreSQL is not running on your current workspace.

Recommended free options:

- Neon PostgreSQL
- Supabase PostgreSQL
- Render PostgreSQL

After creating the database, copy the PostgreSQL connection string. It will look similar to this:

```text
postgresql://username:password@host/database?sslmode=require
```

Open `.env` and add it like this:

```env
DATABASE_URL=postgresql://username:password@host/database?sslmode=require
PORT=8080
SESSION_SECURE=false
```

When `DATABASE_URL` is provided, the project will use it instead of `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`.

Then create the tables using the online database SQL editor. Copy everything from:

```text
db/schema.sql
```

Paste it into the SQL editor and run it.

---

# Setup Option C: PostgreSQL Explorer in VS Code

When adding a PostgreSQL connection in VS Code, use:

```text
Host: localhost
Port: 5432
Username: postgres
Password: postgres
Database: aptitude_db
SSL: Disable
```

If you are using Neon/Supabase/Render, do not use localhost. Use the host, username, password, database name, and SSL option from that platform.

If VS Code asks:

```text
[Optional] The database to connect to
```

Enter:

```text
aptitude_db
```

---

# Run the Go Project

## Step 1: Install Go Packages

Inside the project root folder, run:

```bash
go mod tidy
```

## Step 2: Run Project

```bash
go run .
```

Then open:

```text
http://localhost:8080
```

Admin page:

```text
http://localhost:8080/admin-login.html
```

---

# Excel Templates and Upload Format

The admin pages now include direct download buttons for ready-made Excel templates.

Available templates:

```text
frontend/templates/questions_template.xlsx
frontend/templates/answers_template.xlsx
frontend/templates/combined_questions_answers_template.xlsx
```

Each template has three sheets:

```text
Section A - Analytical Ability
Section B - Verbal Ability
Section C - Quantitative Skills
```

## Questions Template

Recommended columns:

```text
section | question_text | option_a | option_b | option_c | option_d | correct_option
```

The `correct_option` column is optional in the questions upload. If it is filled with A, B, C, or D, the system will also save the answer automatically.

## Answers Template

Recommended columns:

```text
section | question_id | correct_option
```

The `section` column is only for admin clarity. The system links answers using `question_id`.

## Combined Questions and Answers Template

This is the easiest option when uploading a new question bank. Fill the question, options, and correct answer in one file, then upload it from the Questions page.

```text
section | question_text | option_a | option_b | option_c | option_d | correct_option
```

---

# Project Structure

```text
config/        Database connection and .env loading
models/        Data structures
handlers/      API business logic
middleware/    Admin session middleware
routes/        API route definitions
utils/         Helper functions
frontend/      HTML, Tailwind CSS and JS files
frontend/templates/  Downloadable Excel templates for questions and answers
db/            PostgreSQL schema
sample_excel/  Sample Excel upload files
```

---

# Troubleshooting

## Problem: `ECONNREFUSED 127.0.0.1:5432`

Meaning: PostgreSQL is not running on localhost.

Fix:

- Start PostgreSQL if installed locally.
- Or use Neon/Supabase/Render and set `DATABASE_URL` in `.env`.

## Problem: `[sudo] password for vscode`

Meaning: You ran a command requiring sudo permission. This is not from the Go project code.

Fix:

- Avoid sudo commands in Codespaces.
- Use an online PostgreSQL database.
- Or run the project locally on your laptop where you control PostgreSQL.

## Problem: Duplicate CID error

Meaning: A participant with the same CID number is already registered.

Fix:

- Use a different CID number.
- Or remove the old participant record from the database if this was only test data.

## Problem: Admin login not working

Make sure `db/schema.sql` has been executed successfully. The default admin is inserted by that file.

## Problem: Browser cannot open the project

Make sure the Go backend is running:

```bash
go run .
```

Then open:

```text
http://localhost:8080
```

## Important Notes

- Change the default admin password before using it live.
- In production, use HTTPS and set `SESSION_SECURE=true`.
- Add more validation rules if CID or contact number format must follow a strict pattern.
- This version intentionally removes Docker and Docker Compose files.

---

## UI Update in This Version

This version includes an enhanced modern interface for both participant and admin sides:

- Responsive landing/passcode page
- Modern participant registration page
- Professional instruction cards
- Interactive test page with progress indicator
- Improved question option cards
- Modern admin dashboard metrics
- Searchable result, question and answer tables
- Edit buttons for questions and answers
- Cleaner buttons, cards, spacing, shadows and mobile layout

## Latest Functional Update

This version includes:

- Admin-generated random reusable passcodes.
- Passcodes are no longer marked as used after registration.
- Participant registration requires all fields and a confirmation checkbox.
- Manual test submission is blocked until all answers are selected.
- CID number is unique, so two participants cannot register using the same CID.
- Backend validation checks passcode, participant details, CID uniqueness and contact length.


## Latest final update: admin-generated reusable passcodes

This final version does **not** insert participant passcodes from `db/schema.sql`. The database schema only creates the `passcodes` table. Passcodes must be generated by the admin from the dashboard.

### How to generate a passcode

1. Start the Go server.
2. Open `http://localhost:8080/admin-login.html`.
3. Login using the default admin account.
4. On the dashboard, use the **Reusable Participant Passcode Generator** panel.
5. Click **Generate New Reusable Passcode**.
6. Copy and share the generated passcode with participants.

The same passcode can be used by multiple participants. There is no one-time-use limit.

### Important schema note

If you used an older database version, run the latest schema again:

```bash
psql -h localhost -p 5433 -U vscode -d aptitude_db -f db/schema.sql
```

The latest schema removes the old `is_used` column from `passcodes` if it exists.

### Logout button update

The admin logout button has been updated to a red **Secure Exit** button with a power icon across dashboard, questions, and answers pages.


## Latest UI/Workflow Updates

- Admin dashboard auto-refreshes every 15 seconds.
- Browser alert, confirm and prompt popups have been replaced with modern modal dialogs.
- Passcode generation has been moved to a separate `passcodes.html` admin page.
- Passcodes are reusable and can be used by any number of participants.
- Admin navigation includes Dashboard, Questions, Answers, Passcodes and Secure Exit.

## Latest Update: Role-Based Admin Access, Passcode Expiry, and Clean Login Pages

This final version includes the latest requested changes:

- The participant landing page no longer shows the large marketing/statistics section.
- The admin login page no longer shows default account details or the extra promotional panel.
- Admin login is now role-based:
  - **Super Admin** can manage everything: results, questions, answers, passcodes, admin users, access revocation and password changes.
  - **General Admin** can only view participant results, participant details, questions and answers. General Admin cannot add, edit, delete or upload records.
- A new **Admins** page is available only for Super Admin.
- Super Admin can:
  - Add new admin users.
  - Assign Super Admin or General Admin role.
  - Revoke or reactivate admin access.
  - Change admin passwords.
- Passcodes are now time-limited:
  - Generated passcodes expire after **1 hour 30 minutes**.
  - The Passcodes page automatically shows each passcode as **Active** or **Expired**.
  - Super Admin can delete passcodes.
- The Admin Dashboard still refreshes automatically every **15 seconds**.

Default Super Admin:

```text
Username: admin
Password: admin123
```

After extracting the project, run the schema again so the latest role and passcode fields are created:

```bash
psql -h localhost -p 5433 -U vscode -d aptitude_db -f db/schema.sql
```

Then run:

```bash
go mod tidy
go run .
```
