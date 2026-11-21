# Healthcare InSilico

**Human–agent-native infrastructure for simulation, evaluation, and reinforcement learning in clinical environments.**

HealthcareInSilico is an open-source, deployable, multimodal clinical environment that simulates the software used by hospitals and health plans. Clinicians and AI agents work side by side in the same applications, on the same patient record, through standard interfaces including **FHIR, HL7, DICOM, and IHE**.

The platform supports reinforcement learning, agent evaluation, training-data generation, and post-deployment monitoring across the agent lifecycle.

**[Project website](https://sonalisharma-3.github.io/healthcareinsilico/)**

## Quick start

### Prerequisites

- Node.js 22
- npm
- PostgreSQL

### Install and run

```bash
git clone https://github.com/sonalisharma-3/healthcare-insilico-version-1.git
cd healthcare-insilico-version-1
npm install
cp .env.example .env
```

To use PostgreSQL instead of the default SQLite setting in `.env.example`, unset or change `DB_BACKEND` and set `DATABASE_URL`:

```dotenv
DB_BACKEND=postgres
DATABASE_URL=postgres://localhost/healthcare_insilico
```

Create the database if it does not already exist:

```bash
createdb healthcare_insilico
```

Start the environment:

```bash
npm run dev
```

Open **http://localhost:3000**. The desktop displays the available applications; choose a role to sign in.

The development command starts the API, applications, and database connections together. No Docker or separate build step is required for local development.

### Run tests

```bash
npm test
```

## Applications

HealthcareInSilico includes clinical and administrative applications that share patient and workflow state.

| Application | Capabilities | Standards and interfaces |
| --- | --- | --- |
| **Electronic Health Record (EHR)** | Chart review, orders, results, notes, inbox, nursing flowsheets, medication administration record (MAR), handoffs, 12-lead ECG viewer, safety alerts | FHIR R4/R5, HL7 v2.5.1 over MLLP, C-CDA R2.1 |
| **PACS / Radiology** | Worklists, DICOM viewer with window/level, measurements, 3D multiplanar reconstruction (MPR) and prior exams; segmentation and structured reports | DICOMweb, DICOM SEG, DIMSE gateway |
| **Pathology** | Whole-slide viewing across magnifications; region, point and measurement annotations | DICOM WSI, GeoJSON |
| **Pharmacy** | Verification queue, drug-interaction, allergy and dose checks, dispensing | FHIR MedicationRequest/MedicationDispense, HL7 v2 RDE/RDS/RAS |
| **Laboratory Information System (LIS)** | Order-to-release specimen workflow, autoverification, delta checks, critical-value alerts | FHIR ServiceRequest/Specimen/Observation, HL7 v2 ORM/OML/ORU/OUL, LOINC, UCUM |
| **Bed Management** | Bed status, admissions, transfers, discharges, inpatient and observation status | FHIR Location/Encounter, HL7 v2 ADT |
| **Central Station** | Live vitals and alarms from simulated monitors, ventilators and infusion pumps | IEEE 11073 SDC mapped to FHIR Device, DeviceMetric and Observation |
| **Scheduling & Registration** | Provider schedules, check-in and copays, waitlists, recalls, eligibility | FHIR Appointment/Schedule, HL7 v2 SIU, X12 270/271 |
| **Coding & Billing** | ICD-10-CM/PCS, HCPCS and CPT coding; documentation queries, claims, remittances, denials and appeals | X12 837, 835, 277CA |
| **Insurance / Payer** | Prior authorization, concurrent review, claims adjudication, decision clocks, peer-to-peer reviews and appeals | Da Vinci CRD, DTR, PAS, PDex, PCT; X12 278, 835, 834 |
| **Patient Portal** | Results, medications, messaging, refills, appointments, wearables, insurance and claims | FHIR with SMART patient scopes |
| **Post-deployment Surveillance** | Issue reporting and triage, dashboards, drift and subgroup signals; PRR, ROR, IC, EBGM, CUSUM and MaxSPRT statistics | FHIR AdverseEvent, ICH E2B(R3) export |

## Shared patient record and time machine

Every app reads and writes to **one versioned, append-only patient record**.

- **Rewind:** Inspect a chart at a past moment and expose only information available at that time.
- **Branch:** Run each experiment on its own version of the record so one run cannot change another.
- **Audit:** Preserve a history of actions and changes across applications.

### Roles and permissions

The environment includes **Physician, Nurse, Researcher, Patient, Coder, and Payer** roles. Access is enforced server-side for each role and application, with audit logging.

## Research modes

### 1. Training and reinforcement learning

Reset a case to an identical starting state, let an agent act, grade the attempt, and export the results as supervised examples, preference pairs, or trajectories.

Capabilities include multi-agent clinical teams, blinded side-by-side comparison with confidence intervals, and policy hashes to track agent versions.

### 2. Evaluation and safety testing

Run, observe, grade, compare, and promote agents through a promotion gate. Every step is logged for review.

Supported workflows include:

- **Shadow mode:** Observe and compare decisions without changing the active patient chart.
- **Human-in-the-loop:** Require human review of AI-drafted actions before they are signed or executed.
- **Red teaming:** Test prompt injection, wrong-patient images, tenfold-dose errors, and other adversarial or safety-critical scenarios.
- **Missing-data ablation:** Measure sensitivity to unavailable or withheld information.
- **Regression replay:** Rerun previously saved failures after model or policy changes.
- **Longitudinal evaluation:** Check later outcomes of simulated actions.

### 3. Post-deployment surveillance

Collect individual or automated issue reports, including reports from verifier agents. Track rates by agent and version, inspect subgroup performance, and export regulator-oriented reports.

### 4. Data annotation

Clinicians can annotate medical images, pathology slides, and EHR content; mark findings with confidence ratings from **1 to 5**; and optionally record their reasoning.

## Connecting an AI agent

| Agent type | Integration method |
| --- | --- |
| Runs its own control loop | Environment API: `reset`, `step`, `state`, `close` over HTTP or WebSocket, in the style of Gymnasium |
| Supports Model Context Protocol (MCP) | MCP `tools/list` and `tools/call` per episode or hospital system |
| Reads and writes FHIR | FHIR API with agent-specific key and permissions |
| Provides clinical decision support | CDS Hooks: `patient-view`, `order-select`, `order-sign` |
| Is a SMART application | SMART on FHIR launch from the patient chart |
| Exposes only a model endpoint | Reference harness wraps the model in a small, neutral agent loop |

### Additional integrations and reference workflows

- **Ambient scribe:** Plug in speech-recognition and language models.
- **Conversational patient simulator:** Interact with a patient model grounded in the clinical chart.
- **Wearables:** Pair devices and synchronize wearable data.
- **Reference agents:** A radiology report drafter and an inbox triager are included as simple **rule-based placeholders** that can be replaced with a model of your choice.

## Patient data

You can load your own clinical data into the local `data/` folder.

Import FHIR resources:

```bash
npm run import -- --fhir <folder>
```

Import DICOM imaging:

```bash
npm run import -- --dicom <folder>
```

## Deployment

### Local development

Follow the [quick start](#quick-start) instructions above.

### Linux server

Use a Linux host with Node.js 22 and PostgreSQL. Configure `DATABASE_URL` in `.env`, install dependencies, and manage the application process using a service manager such as `systemd`.

```bash
npm install
npm run dev
```

Place the deployment behind **HTTPS**. Configure production access control and secret management appropriate to your environment.

### Google Cloud

The platform's Google Cloud deployment architecture uses:

- **Cloud Run** for the application
- **Cloud SQL (PostgreSQL)** for the record store
- **Private Cloud Storage** mounted as `data/` for radiology images, pathology slides, and ECG files


---

*HealthcareInSilico is a research and simulation infrastructure, not a substitute for validated clinical systems or professional clinical judgment.*
