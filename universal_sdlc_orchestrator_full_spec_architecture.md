# Universal SDLC Orchestrator
## Full MVP Specification & Architecture

**Version:** 1.0  
**Status:** Implementation specification  
**Primary goal:** Build one adaptive SDLC control plane that can lead projects of any size or technology while dynamically selecting the smallest effective team, routing work across one or multiple LLMs, maximizing safe parallelism, preventing merge conflicts, and enforcing automated verification.

---

# 1. Executive Summary

The Universal SDLC Orchestrator is a control plane that sits above coding agents and LLM providers.

It is not itself a giant coding agent.

Its job is to coordinate a complete software-development organization:

- Product Manager
- Business Analyst
- Researcher
- Requirements Analyst
- Enterprise Architect
- Solution Architect
- Technical Lead
- UX Designer
- UI Designer
- Frontend Engineer
- Backend Engineer
- API Engineer
- Database Engineer
- Data Engineer
- Integration/Middleware Engineer
- QA Engineer
- UI/E2E Tester
- Visual QA
- Security Engineer
- Performance Engineer
- DevOps Engineer
- Release Engineer
- Documentation Engineer
- Recovery/Debug Engineer
- Independent Reviewer

The orchestrator owns the outcome.

Workers own bounded implementation tasks.

The system dynamically activates the roles required for the current project instead of running every role continuously.

The preferred LLM topology is:

```text
CHEAP
  ↓
BASE
  ↓
ELEVATED
  ↓
HUMAN
```

A minimum deployment supports one model. The preferred deployment uses three models:

- Cheap: high-volume/simple work
- Base: normal engineering
- Elevated: difficult reasoning, recovery, architecture, and stuck-loop resolution

Multiple models can exist within any tier.

---

# 2. Design Goals

## 2.1 Primary goals

1. Support any software project.
2. Support any programming language.
3. Support new and existing repositories.
4. Support UI-only work.
5. Support APIs.
6. Support backend services.
7. Support middleware/integration.
8. Support data pipelines.
9. Support full-stack applications.
10. Support large enterprise applications.
11. Dynamically compose teams.
12. Dynamically route tasks to models.
13. Support one or many LLMs.
14. Maximize safe parallel execution.
15. Prevent agent merge conflicts.
16. Enforce meaningful automated testing.
17. Test UI behavior.
18. Perform visual UI inspection.
19. Detect repeated/stuck loops.
20. Automatically escalate difficult work.
21. Preserve project decisions and architecture.
22. Minimize context sent to workers.
23. Track cost, tokens, duration, attempts, and outcomes.
24. Keep the initial implementation low-tech and fast.

## 2.2 Non-goals for MVP

Do not initially build:

- Kubernetes orchestration
- Distributed cloud workers
- Kafka
- Redis
- Complex microservices
- Custom model inference
- Custom terminal emulator
- Custom Git implementation
- Custom browser engine
- Custom IDE
- Fully autonomous production deployment without gates

The MVP should prove orchestration, not infrastructure complexity.

---

# 3. Core Principle

## One Lead, many specialists

```text
                         USER
                           |
                           v
                  +------------------+
                  | SDLC ORCHESTRATOR|
                  |                  |
                  | Single authority |
                  +---------+--------+
                            |
                    COMPLETE ROLE SET
                            |
            +---------------+---------------+
            |               |               |
            v               v               v
        DISCOVERY       ENGINEERING      QUALITY
            |               |               |
            +---------------+---------------+
                            |
                         TASK DAG
                            |
              +-------------+-------------+
              |             |             |
              v             v             v
           WORKER        WORKER        WORKER
              |             |             |
           WORKTREE      WORKTREE      WORKTREE
              |             |             |
              +-------------+-------------+
                            |
                       VERIFICATION
                            |
                            v
                         INTEGRATE
                            |
                            v
                           DONE
```

The orchestrator is the only permanent decision-making authority.

Workers do not independently redefine:

- requirements
- architecture
- scope
- acceptance criteria
- project completion

---

# 4. System Architecture

```text
+-------------------------------------------------------------------+
|                           USER / CLI / UI                         |
+--------------------------------+----------------------------------+
                                 |
                                 v
+-------------------------------------------------------------------+
|                     SDLC ORCHESTRATOR CORE                       |
|                                                                   |
|  Lead | State Machine | Planner | Router | Scheduler | Evaluator |
+-------------------------------+-----------------------------------+
                                |
        +-----------------------+------------------------+
        |                       |                        |
        v                       v                        v
+---------------+       +---------------+       +---------------+
| Project       |       | Team / Agent  |       | Model         |
| Intelligence  |       | Registry      |       | Router        |
+---------------+       +---------------+       +---------------+
| Discovery     |       | Roles         |       | Cheap         |
| Complexity    |       | Capabilities  |       | Base          |
| Architecture  |       | Availability  |       | Elevated      |
| Context       |       | Policies      |       | Multi-model   |
+---------------+       +---------------+       +---------------+
        |                       |                        |
        +-----------------------+------------------------+
                                |
                                v
+-------------------------------------------------------------------+
|                         TASK ENGINE                               |
|                                                                   |
| DAG | Dependencies | Ownership | Resource Locks | Scheduling     |
+--------------------------------+----------------------------------+
                                 |
                                 v
+-------------------------------------------------------------------+
|                       EXECUTION LAYER                             |
|                                                                   |
| Git Worktrees | Shell | Files | Git | Existing Agent Harnesses    |
+--------------------------------+----------------------------------+
                                 |
                                 v
+-------------------------------------------------------------------+
|                       VERIFICATION                                |
|                                                                   |
| Unit | Integration | API | E2E | Visual | Security | Performance  |
+--------------------------------+----------------------------------+
                                 |
                                 v
+-------------------------------------------------------------------+
|                    STATE / EVIDENCE / MEMORY                      |
|                                                                   |
| SQLite | Decisions | Requirements | Results | Artifacts | Events  |
+-------------------------------------------------------------------+
```

---

# 5. Recommended MVP Technology

## 5.1 Primary implementation

Use:

```text
Python
SQLite
Git
Git worktrees
Playwright
Existing coding-agent harness
```

Python is recommended because the MVP is primarily:

- orchestration
- process management
- JSON/YAML handling
- filesystem operations
- Git operations
- API integration
- test execution
- model routing

The bottleneck will be LLM execution, not Python CPU performance.

## 5.2 Do not start with Rust

Rust is useful later for:

- high-volume process supervision
- filesystem watchers
- a long-running execution daemon
- distributed worker scheduling
- extreme concurrency

But it should not be used to slow down the MVP.

Potential future split:

```text
Python
  = orchestration/intelligence

Rust
  = high-performance execution runtime
```

Only make this split after profiling demonstrates a need.

---

# 6. Existing Harness Strategy

The orchestrator should not rebuild an agent framework.

Use adapters.

Supported MVP adapters:

```text
OpenCodeAdapter
PiAdapter
DeepSeekAdapter
GenericCLIAdapter
```

The orchestrator calls a common interface:

```python
class AgentAdapter:

    def launch(self, task, worktree, model):
        ...

    def status(self, process):
        ...

    def collect_result(self, process):
        ...

    def stop(self, process):
        ...
```

The first implementation should use whichever existing harness currently has the best:

- tool execution
- repository navigation
- coding reliability
- model/provider support

The orchestrator must remain independent of that choice.

---

# 7. Complete SDLC Role Registry

The MVP includes the complete team as role definitions.

## Leadership

### SDLC Orchestrator / Lead

Owns:

- project state
- decisions
- delegation
- dependencies
- escalation
- completion

### Product Manager

Owns:

- goals
- scope
- priorities
- outcomes

### Business Analyst

Owns:

- business requirements
- workflows
- actors
- business rules

### Researcher

Owns:

- technology research
- external documentation
- existing-system investigation
- uncertainty reduction

## Architecture

### Enterprise Architect

Owns:

- system boundaries
- enterprise concerns
- cross-system architecture

### Solution Architect

Owns:

- application architecture
- services
- integrations
- data flow

### Technical Lead

Owns:

- implementation decisions
- engineering conventions
- difficult technical decisions

## Experience

### UX Designer

Owns:

- user flows
- information architecture
- usability

### UI Designer

Owns:

- visual hierarchy
- layout
- components
- design consistency

## Engineering

### Frontend Engineer

Owns:

- UI implementation
- client behavior
- state management

### Backend Engineer

Owns:

- services
- business logic
- server behavior

### API Engineer

Owns:

- REST
- GraphQL
- contracts
- API versioning

### Database Engineer

Owns:

- schema
- indexes
- queries
- migrations

### Data Engineer

Owns:

- ETL
- ELT
- transformations
- data movement

### Integration Engineer

Owns:

- middleware
- connectors
- message flows
- external systems

## Quality

### QA Engineer

Owns:

- test strategy
- integration testing
- acceptance verification

### UI/E2E Engineer

Owns:

- browser automation
- end-to-end workflows

### Visual QA

Owns:

- screenshots
- responsive behavior
- visual defects
- layout inspection

### Security Engineer

Owns:

- threat analysis
- security testing
- authentication/authorization review
- dependency risks

### Performance Engineer

Owns:

- load
- latency
- resource usage
- bottleneck analysis

## Delivery

### DevOps Engineer

Owns:

- CI/CD
- containers
- environments
- infrastructure

### Release Engineer

Owns:

- release readiness
- versioning
- deployment gates
- rollback

### Documentation Engineer

Owns:

- technical docs
- API docs
- operational docs
- user documentation

### Recovery Engineer

Owns:

- repeated failures
- root-cause analysis
- stuck-loop resolution
- recovery plans

### Independent Reviewer

Owns:

- independent evaluation
- architecture review
- implementation review
- acceptance challenge

---

# 8. Dynamic Team Composition

The full roster exists in the system.

The active team is generated from project requirements.

Example:

```text
Project:
Simple landing page

Active:
  Lead
  UI Designer
  Frontend Engineer
  Visual QA
```

Example:

```text
Project:
REST API

Active:
  Lead
  Architect
  Backend
  Database
  API
  QA
  Security
```

Example:

```text
Project:
Enterprise ERP

Active:
  Lead
  Product
  BA
  Research
  Enterprise Architect
  Solution Architect
  UX
  UI
  Frontend
  Backend
  API
  Database
  Data
  Integration
  QA
  E2E
  Visual QA
  Security
  Performance
  DevOps
  Release
  Documentation
```

The system must avoid activating roles that provide no useful work.

---

# 9. Project Discovery

For an existing repository, automatically inspect:

```text
Git
Languages
Frameworks
Package managers
Build systems
Databases
API definitions
Infrastructure
CI/CD
Tests
Documentation
Configuration
Environment files
Existing architecture
```

Output:

```yaml
project_profile:
  languages:
  frameworks:
  databases:
  services:
  frontend:
  backend:
  integrations:
  infrastructure:
  testing:
  deployment:
```

For a new project, infer requirements from the request and ask only questions that materially affect implementation.

---

# 10. Complexity Engine

The MVP uses deterministic scoring.

```python
score = (
    domains * 0.15 +
    files * 0.10 +
    integrations * 0.15 +
    database_changes * 0.10 +
    security * 0.10 +
    ui * 0.10 +
    external_dependencies * 0.10 +
    deployment * 0.10 +
    testing_complexity * 0.10
)
```

Normalize to 0–1.

```text
0.00 - 0.25  Tiny
0.25 - 0.45  Small
0.45 - 0.65  Medium
0.65 - 0.80  Large
0.80 - 1.00  Enterprise
```

Complexity determines:

- number of active roles
- planning depth
- verification depth
- model requirements
- allowed parallelism
- escalation sensitivity

---

# 11. Model Architecture

## 11.1 Three-tier default

Preferred configuration:

```text
CHEAP
  |
  +-- high-volume
  +-- simple implementation
  +-- documentation
  +-- tests
  +-- mechanical changes

BASE
  |
  +-- normal coding
  +-- debugging
  +-- API work
  +-- UI work
  +-- integration

ELEVATED
  |
  +-- architecture
  +-- difficult debugging
  +-- repeated failure
  +-- security decisions
  +-- stuck loops
  +-- recovery
```

Recommended usage target:

```text
Cheap:     60-80%
Base:      15-35%
Elevated:   5-10%
```

These are targets, not hard limits.

## 11.2 Minimum configurations

One model:

```text
BASE
```

Two models:

```text
BASE
ELEVATED
```

Preferred:

```text
CHEAP
BASE
ELEVATED
```

Advanced:

```text
CHEAP:    multiple models
BASE:     multiple models
ELEVATED: multiple models
```

## 11.3 Models are not tied to roles

Bad:

```text
Frontend = Model A
Backend = Model B
QA = Model C
```

Correct:

```text
ROLE
  ↓
TASK
  ↓
TASK DIFFICULTY
  ↓
MODEL ROUTER
  ↓
MODEL
```

A backend worker can use Cheap for trivial CRUD and Elevated for a difficult distributed consistency problem.

---

# 12. Model Router

The router considers:

```text
Task complexity
Task risk
Task type
Required capabilities
Required modality
Context size
Model latency
Model cost
Historical success
Previous failures
Current load
```

Example:

```python
model = router.select(
    task=task,
    complexity=task.complexity,
    risk=task.risk,
    required_capabilities=task.capabilities
)
```

The router should prefer the cheapest reliable model.

Not the cheapest model at all costs.

Not the strongest model at all costs.

The objective is:

```text
minimum cost
+
minimum latency
+
acceptable reliability
```

---

# 13. Multi-LLM Modes

## Single model

```text
Task
 ↓
Model
```

## Routed multi-model

```text
Task
 ↓
Router
 ├── Cheap
 ├── Base
 └── Elevated
```

## Collaborative

```text
Question
   |
   +---- Model A
   +---- Model B
   +---- Model C
            |
            v
       Elevated
            |
            v
      Final decision
```

Collaborative mode is reserved for:

- architecture disputes
- security decisions
- difficult debugging
- repeated failures
- major refactoring
- uncertain technology choices

---

# 14. Elevation and Recovery

The elevated model is a first-class part of the MVP.

## Escalation path

```text
CHEAP
  |
  | fail
  v
BASE
  |
  | fail
  v
ELEVATED
  |
  | fail
  v
ARCHITECTURE REVIEW
  |
  | unresolved
  v
USER
```

The elevated model receives failure evidence.

Example:

```yaml
elevation_request:
  task_id: API-042

  attempts:
    - model: cheap
      result: failed
    - model: cheap
      result: failed
    - model: base
      result: failed

  failures:
    - refresh token test failed
    - integration timeout

  changed_files:
    - src/auth/**
    - tests/auth/**

  test_output: ...

  previous_decisions: ...

  request:
    diagnose root cause and propose corrective action
```

The elevated model should not simply retry the same prompt.

It must:

1. Diagnose.
2. Identify the failure pattern.
3. Determine whether the task is incorrectly decomposed.
4. Determine whether the architecture is wrong.
5. Produce a corrective plan.
6. Delegate or execute the corrective work.

---

# 15. Loop Detection

Detect:

```text
same task
+
same files
+
same error
+
same approach
+
repeated attempts
```

Example:

```text
LOOP DETECTED

Task: AUTH-042
Attempts: 4
Repeated failure: refresh token validation
Same files: src/auth/token.py

Action:
Stop worker.
Escalate.
```

Do not allow infinite agent retries.

---

# 16. Task Model

Every task must have a contract.

```yaml
task:
  id: API-042

  title: Create customer endpoint

  objective: Create POST /api/customers

  dependencies:
    - DB-001
    - AUTH-001

  capabilities:
    - backend
    - api
    - testing

  acceptance_criteria:
    - valid payload accepted
    - invalid payload rejected
    - authentication required
    - customer persisted
    - correct status code
    - automated tests

  allowed_paths:
    - src/customers/**
    - tests/customers/**

  forbidden_paths:
    - src/auth/**

  verification:
    - unit
    - integration
    - api
```

Workers must produce evidence against acceptance criteria.

---

# 17. Dependency DAG

Tasks are not a flat list.

```text
Database
   |
   +----> API
   |        |
   |        +----> Integration
   |
   +----> UI
            |
            +----> E2E

API + UI
   |
   v
Integration Verification
```

Only dependency-free tasks run immediately.

---

# 18. Parallelization

The system should maximize parallelism subject to safety.

```python
ready = graph.ready_tasks()

for task in ready:

    if ownership_conflict(task):
        continue

    if resource_conflict(task):
        continue

    if dependency_blocked(task):
        continue

    dispatch(task)
```

The goal is:

> Maximum safe concurrency with zero known ownership collisions.

---

# 19. Git Worktree Isolation

Every worker gets:

```text
worktrees/
  task-001/
  task-002/
  task-003/
```

Each has:

```text
branch: sdlc/task-001
```

Workers never edit another worker's worktree.

This prevents most simultaneous-agent merge problems before they occur.

---

# 20. File Ownership

Each task declares or derives:

```text
allowed_paths
```

Example:

```text
Task A
  src/customers/**
  tests/customers/**

Task B
  src/orders/**
  tests/orders/**

Task C
  database/migrations/**
```

If two tasks need the same path:

```text
CONFLICT
```

The scheduler must serialize or restructure the tasks.

---

# 21. Shared Resource Locks

High-conflict files are exclusive resources:

```text
package.json
package-lock.json
pnpm-lock.yaml
Cargo.lock
pyproject.toml
docker-compose.yml
CI files
global configuration
central routing
shared schemas
```

Example:

```python
with resource_lock("package.json"):
    execute(task)
```

This is preferable to discovering the conflict during merge.

---

# 22. Integration Strategy

Do not blindly merge every branch.

Pipeline:

```text
Worker
  ↓
Local verification
  ↓
Independent verification
  ↓
Integration branch
  ↓
Build
  ↓
Full test suite
  ↓
Security
  ↓
Visual verification
  ↓
Accept
```

A task is not complete merely because its worker stopped successfully.

---

# 23. Testing Architecture

## Verification order

Run cheapest checks first:

```text
1. Syntax
2. Type checking
3. Lint
4. Unit tests
5. Integration tests
6. API tests
7. E2E
8. Visual
9. Security
10. Performance
11. Full build
```

Fail fast where possible.

---

# 24. Unit Testing

Every changed behavior should have meaningful tests.

The orchestrator checks:

```text
Production behavior changed?
       |
       v
Relevant test changed/added?
       |
       +---- NO ---> REJECT
       |
       YES
       |
       v
Run tests
```

Do not enforce arbitrary coverage percentages.

Enforce behavioral coverage.

---

# 25. API Testing

For API changes:

```text
Contract
Validation
Authentication
Authorization
Happy path
Failure path
Boundary conditions
Persistence
Response shape
Status codes
```

Use existing project tooling where possible.

---

# 26. UI/E2E Testing

Use Playwright for the MVP.

Example flow:

```text
Launch application
      ↓
Navigate
      ↓
Perform user action
      ↓
Assert visible result
      ↓
Capture console errors
      ↓
Capture network failures
      ↓
Capture screenshot
```

UI changes should generate or update relevant E2E tests.

---

# 27. Visual Inspection

Visual inspection is separate from functional testing.

Trigger when:

```text
UI changed
CSS changed
component changed
layout changed
routing changed
user-visible behavior changed
```

Automated checks:

- screenshot comparison
- viewport sizes
- overflow
- clipping
- missing elements
- console errors
- network errors
- accessibility basics

AI visual review checks:

- alignment
- spacing
- hierarchy
- consistency
- responsive layout
- obvious defects
- missing controls
- unusable states

---

# 28. Responsive Visual Matrix

At minimum:

```text
Desktop
  1440x900

Tablet
  1024x768

Mobile
  390x844
```

Only use all viewports when the UI change warrants it.

---

# 29. Security Verification

Security checks should be risk-based.

Inspect:

```text
Authentication
Authorization
Input validation
Injection
Secrets
Dependencies
File access
Command execution
CORS
CSRF
Session handling
Logging
Sensitive data exposure
```

High-risk changes automatically involve the Security role and may require Elevated reasoning.

---

# 30. Performance Verification

Trigger when relevant:

```text
database-heavy change
API latency-sensitive change
large data processing
high-volume integration
rendering-heavy UI
concurrency
caching
```

Measure:

```text
latency
throughput
CPU
memory
database query behavior
bundle size where relevant
```

Do not run expensive performance tests on every tiny change.

---

# 31. Project Memory

Use filesystem artifacts plus SQLite.

Recommended structure:

```text
.sdlc/

  constitution.md

  requirements/
  architecture/
  decisions/
  tasks/
  plans/
  verification/
  reports/
  context/

  sdlc.db
```

---

# 32. Project Constitution

Contains:

```text
Architecture rules
Coding standards
Naming
Security policies
Testing policies
Technology constraints
Deployment rules
Repository conventions
```

Workers receive the relevant portions, not necessarily the entire file.

---

# 33. Decision Ledger

Every significant architecture decision becomes an ADR-like record.

```yaml
decision:
  id: ADR-017

  question:
    Which database should be used?

  decision:
    PostgreSQL

  reason:
    Transactional workload and existing infrastructure.

  alternatives:
    - MySQL
    - MongoDB

  consequences:
    - PostgreSQL-specific SQL permitted
    - migrations required
```

The orchestrator must check existing decisions before inventing new architecture.

---

# 34. Context Management

Workers should receive:

```text
Project summary
+
Task
+
Acceptance criteria
+
Relevant files
+
Relevant decisions
+
Relevant test failures
+
Relevant architecture
```

Do not provide the entire repository by default.

Context should be task-specific.

---

# 35. State Machine

Project states:

```text
DISCOVERY
REQUIREMENTS
ARCHITECTURE
PLANNING
IMPLEMENTATION
INTEGRATION
VERIFICATION
RELEASE
MAINTENANCE
BLOCKED
```

Task states:

```text
BACKLOG
READY
ASSIGNED
IN_PROGRESS
VERIFYING
FAILED
ESCALATED
ACCEPTED
BLOCKED
```

The runtime, not the LLM, controls state transitions.

---

# 36. LLM Decision vs Runtime Execution

The LLM proposes decisions.

The runtime enforces them.

Bad:

```text
LLM
 ├── decides
 ├── edits
 ├── declares completion
 └── decides success
```

Correct:

```text
LLM
 ↓
Decision
 ↓
Runtime validates policy
 ↓
Runtime executes
 ↓
Runtime verifies
 ↓
Runtime updates state
```

This is a critical reliability boundary.

---

# 37. Model Registry

Example:

```yaml
model:
  id: model-x
  provider: openrouter
  tier: base

  capabilities:
    coding: true
    reasoning: true
    vision: true

  context_window: 128000

  estimated_cost:
    input: 0.00
    output: 0.00

  estimated_speed:
    tokens_per_second: 100
```

The registry should track actual performance over time.

---

# 38. Model Performance History

Track:

```text
model
task type
complexity
duration
tokens
cost
attempts
success
failure
test result
escalation
```

This allows routing to improve from actual project history.

Example:

```text
Model A:
  UI success: 97%
  API success: 89%

Model B:
  UI success: 91%
  API success: 98%
```

The router can learn:

```text
UI → Model A
API → Model B
```

without hard-coding those assignments.

---

# 39. Cost and Speed Optimization

Optimization objective:

```text
Minimize:

cost
+
latency
+
failure/rework
```

A cheap model that fails three times may be slower and more expensive than a base model.

Therefore calculate approximate expected cost:

```text
expected_cost =
    model_cost
    +
    probability_of_failure * expected_rework_cost
```

Likewise:

```text
expected_time =
    execution_time
    +
    probability_of_failure * recovery_time
```

Use those estimates for routing.

---

# 40. Agent Concurrency

Concurrency should depend on:

```text
CPU
RAM
available model capacity
provider rate limits
task independence
repository conflict risk
browser capacity
database capacity
```

Example:

```yaml
concurrency:
  max_workers: auto
  max_parallel_ui: 2
  max_parallel_e2e: 2
  max_shared_resource_tasks: 1
```

Never create unlimited agents simply because tasks exist.

---

# 41. Browser Isolation

Each UI/E2E worker should have isolated:

- browser context
- test data
- screenshots
- logs

Prefer deterministic test fixtures.

---

# 42. Evidence Model

Every task produces evidence.

```yaml
evidence:
  task_id: API-042

  files_changed:
    - src/customers/api.py

  tests:
    unit: pass
    integration: pass
    api: pass

  build:
    pass

  security:
    pass

  review:
    pass

  duration_seconds: 420

  tokens: 42110

  model: base-model
```

Completion requires sufficient evidence for the task risk.

---

# 43. Independent Review

Workers should not be the sole judge of their own work.

```text
Coder
  ↓
Independent Reviewer
  ↓
Verification
  ↓
Accept / Reject
```

For high-risk tasks:

```text
Coder
  ↓
Reviewer
  ↓
Elevated Model
  ↓
Security / Architecture
  ↓
Accept
```

---

# 44. Recovery Workflow

```text
Task
 ↓
Worker
 ↓
Test
 ↓
FAIL
 ↓
Retry
 ↓
FAIL
 ↓
Base
 ↓
FAIL
 ↓
Elevated
 ↓
Root Cause
 ↓
Replan
 ↓
Worker
 ↓
Verify
```

Maximum retry counts must be configurable.

No infinite loops.

---

# 45. User Escalation

Escalate when:

- architecture is ambiguous
- requirements conflict
- security risk cannot be resolved
- repeated failure persists
- external dependency is unavailable
- required credentials are missing
- destructive operation is proposed
- production-impacting decision requires approval

Example:

```text
BLOCKED

Reason:
The required API has two incompatible authentication models.

Options:

1. OAuth
2. API key
3. Support both

Recommended:
Option 1

Why:
...
```

---

# 46. Repository Safety

The orchestrator must support policies:

```text
allowed commands
forbidden commands
protected branches
protected files
production restrictions
secret restrictions
destructive-operation approval
```

Never expose secrets unnecessarily to workers.

---

# 47. CLI MVP

Example:

```bash
sdlc init
sdlc run "Build customer management"
sdlc status
sdlc tasks
sdlc workers
sdlc models
sdlc logs
sdlc verify
sdlc resume
sdlc stop
```

Useful:

```bash
sdlc explain TASK-042
sdlc retry TASK-042
sdlc elevate TASK-042
sdlc approve
sdlc reject
```

---

# 48. Configuration

Example:

```yaml
project:
  name: my-project
  repository: .

models:

  cheap:
    - provider: openrouter
      model: user-selected

  base:
    - provider: openrouter
      model: user-selected

  elevated:
    - provider: openrouter
      model: user-selected

agents:

  max_concurrency: auto

execution:
  worktrees: true

testing:
  unit: true
  integration: true
  e2e: true
  visual: true
  security: true
  performance: auto

routing:
  max_retries: 2
  escalate_after_failures: 2
  collaborative_mode: auto
```

---

# 49. SQLite Schema

Initial tables:

```text
projects
tasks
task_dependencies
task_resources
workers
worker_runs
models
model_runs
artifacts
decisions
requirements
test_results
visual_results
events
escalations
```

Keep relational state simple.

Use files for large artifacts.

Use SQLite for metadata and state.

---

# 50. Event Log

Every important action becomes an event:

```yaml
event:
  timestamp:
  project_id:
  task_id:
  actor:
  action:
  model:
  result:
  duration:
```

Examples:

```text
TASK_CREATED
TASK_ASSIGNED
WORKER_STARTED
WORKER_FINISHED
TEST_STARTED
TEST_FAILED
LOOP_DETECTED
MODEL_ESCALATED
TASK_ACCEPTED
TASK_REJECTED
MERGE_COMPLETED
RELEASE_APPROVED
```

This makes debugging the orchestrator itself much easier.

---

# 51. Suggested Repository Structure

```text
universal-sdlc/
│
├── cli.py
├── pyproject.toml
├── README.md
│
├── orchestrator/
│   ├── lead.py
│   ├── state_machine.py
│   ├── planner.py
│   ├── router.py
│   ├── scheduler.py
│   ├── evaluator.py
│   └── escalation.py
│
├── discovery/
│   ├── repository.py
│   ├── languages.py
│   ├── frameworks.py
│   ├── architecture.py
│   └── complexity.py
│
├── agents/
│   ├── registry.py
│   ├── roles.py
│   ├── capabilities.py
│   └── launcher.py
│
├── models/
│   ├── registry.py
│   ├── router.py
│   ├── providers.py
│   └── scoring.py
│
├── tasks/
│   ├── model.py
│   ├── graph.py
│   ├── ownership.py
│   └── locks.py
│
├── execution/
│   ├── process.py
│   ├── filesystem.py
│   ├── shell.py
│   └── context.py
│
├── git/
│   ├── worktree.py
│   ├── branch.py
│   └── integration.py
│
├── verification/
│   ├── unit.py
│   ├── integration.py
│   ├── api.py
│   ├── e2e.py
│   ├── visual.py
│   ├── security.py
│   └── performance.py
│
├── memory/
│   ├── project.py
│   ├── decisions.py
│   └── context.py
│
├── adapters/
│   ├── base.py
│   ├── opencode.py
│   ├── pi.py
│   ├── deepseek.py
│   └── generic.py
│
└── state/
    └── database.py
```

---

# 52. MVP Implementation Sequence

## Phase 1 — Control plane

Build:

```text
CLI
SQLite
Project discovery
State machine
Task model
Model registry
```

## Phase 2 — Full team registry

Implement all roles and capabilities.

Do not implement separate codebases for each role.

Roles should primarily be:

```text
prompt
capabilities
permissions
verification policy
routing policy
```

## Phase 3 — Existing harness adapter

Connect one existing coding harness.

Validate:

```text
task → worker → files → result
```

## Phase 4 — Git isolation

Implement:

```text
worktree creation
branch creation
cleanup
integration
conflict detection
```

## Phase 5 — Parallel scheduler

Implement:

```text
DAG
ownership
resource locks
concurrency
```

## Phase 6 — Verification

Implement:

```text
unit
integration
API
E2E
```

## Phase 7 — Visual QA

Add:

```text
Playwright
screenshots
visual inspection
AI visual reviewer
```

## Phase 8 — Elevation

Add:

```text
loop detection
failure evidence
cheap → base → elevated
recovery
```

## Phase 9 — Multi-model

Add:

```text
multiple providers
multiple models per tier
model scoring
historical routing
collaborative review
```

---

# 53. MVP Acceptance Test

The MVP should not be considered complete until it can successfully handle all of these:

## Test 1 — Tiny UI change

```text
User:
Change button color.

Expected:
UI role
Cheap model
Visual verification
No unnecessary agents
```

## Test 2 — New API

```text
User:
Create customer API.

Expected:
Architect
Backend
Database
API
QA
Security as appropriate

Parallel:
database + API planning

Sequential:
database implementation → dependent API work

Verification:
unit + integration + API
```

## Test 3 — Middleware

```text
User:
Move customer records from System A to System B.

Expected:
BA
Architect
Integration
Data
Backend
QA
Security
DevOps as required
```

## Test 4 — Complex UI

Expected:

```text
UX
UI
Frontend
E2E
Visual QA
Accessibility
```

## Test 5 — Stuck worker

Expected:

```text
Cheap
 ↓
failure
 ↓
retry
 ↓
Base
 ↓
failure
 ↓
Elevated
 ↓
root-cause analysis
```

## Test 6 — Collision

Two workers request:

```text
package.json
```

Expected:

```text
No parallel execution.
Resource lock.
```

## Test 7 — Visual defect

Worker says:

```text
DONE
```

Visual QA finds:

```text
mobile layout overflow
```

Expected:

```text
REJECT
 ↓
worker receives evidence
 ↓
fix
 ↓
visual verification
 ↓
PASS
```

## Test 8 — Architecture disagreement

Two models produce conflicting designs.

Expected:

```text
Independent analysis
 ↓
Elevated model
 ↓
Decision ledger
 ↓
Selected architecture
```

---

# 54. Performance Strategy

The system should optimize four things:

```text
1. Model latency
2. Parallelism
3. Context size
4. Rework
```

The fastest system is not necessarily the one with the fastest model.

It is the one that avoids unnecessary work.

Primary optimizations:

```text
Task-specific context
Safe parallelism
Cheap-first routing
Fail-fast tests
Early loop detection
Worktree isolation
Incremental verification
Selective visual testing
Selective security/performance testing
```

---

# 55. Recommended Default Routing Policy

```text
If task is trivial:
    CHEAP

If task is normal:
    CHEAP if historical success is high
    otherwise BASE

If task is architectural:
    BASE or ELEVATED

If task has failed once:
    BASE

If task has failed twice:
    ELEVATED

If same failure repeats:
    LOOP DETECTOR → ELEVATED

If security-critical:
    ELEVATED review

If architecture conflict:
    MULTI-MODEL → ELEVATED

If production-impacting:
    ELEVATED + HUMAN approval
```

---

# 56. The Full Operating Model

```text
                       USER REQUEST
                            |
                            v
                       DISCOVERY
                            |
                            v
                     COMPLEXITY SCORE
                            |
                            v
                     TEAM COMPOSER
                            |
                            v
                     REQUIREMENTS
                            |
                            v
                      ARCHITECTURE
                            |
                            v
                       TASK DAG
                            |
                            v
                     MODEL ROUTER
                            |
             +--------------+--------------+
             |              |              |
           CHEAP          BASE         ELEVATED
             |              |              |
             +--------------+--------------+
                            |
                      WORKTREE POOL
                            |
                     PARALLEL EXECUTION
                            |
                            v
                      LOCAL TESTING
                            |
                            v
                    INDEPENDENT REVIEW
                            |
                            v
                     INTEGRATION TEST
                            |
                +-----------+-----------+
                |                       |
               UI                     NON-UI
                |                       |
                v                       |
          PLAYWRIGHT                    |
                |                       |
          VISUAL QA                     |
                |                       |
                +-----------+-----------+
                            |
                         SECURITY
                            |
                       PERFORMANCE
                            |
                          BUILD
                            |
                        ACCEPT
                            |
                         RELEASE
```

---

# 57. Final Architecture Decision

The MVP should be:

```text
                 PYTHON CONTROL PLANE
                         |
       +-----------------+------------------+
       |                 |                  |
    FULL TEAM       MULTI-LLM           VERIFIER
    REGISTRY          ROUTER             ENGINE
       |                 |                  |
       +-----------------+------------------+
                         |
                    TASK DAG
                         |
                 GIT WORKTREES
                         |
                PARALLEL WORKERS
                         |
                  EVIDENCE ENGINE
                         |
               ACCEPT / REJECT / ESCALATE
```

Use:

```text
Python
SQLite
Git worktrees
Playwright
One existing agent harness initially
Cheap + Base + Elevated models
```

Do not build a new agent runtime unless the existing harness prevents a required capability.

Do not use Rust until the Python runtime is proven to be the bottleneck.

---

# 58. Definition of Done for the MVP

The MVP is complete when a user can run:

```bash
sdlc run "Build this application"
```

and the system can independently:

```text
1. Inspect the project.
2. Understand the request.
3. Determine complexity.
4. Assemble the required SDLC team.
5. Select the appropriate models.
6. Create requirements.
7. Create architecture.
8. Decompose work.
9. Build a dependency graph.
10. Assign isolated worktrees.
11. Execute independent tasks in parallel.
12. Prevent ownership conflicts.
13. Use cheap/base/elevated routing.
14. Detect stuck loops.
15. Escalate failed work.
16. Run unit tests.
17. Run integration tests.
18. Run API tests.
19. Run browser tests.
20. Visually inspect UI changes.
21. Perform security checks where appropriate.
22. Perform performance checks where appropriate.
23. Independently review results.
24. Integrate only verified work.
25. Preserve decisions and evidence.
26. Report cost, tokens, duration, failures, and progress.
27. Ask the user only when genuinely blocked.
```

## The central architectural rule

> **The orchestrator controls the SDLC. LLMs provide reasoning. Workers provide execution. The runtime provides safety. Tests provide evidence. Git worktrees provide isolation.**

That separation is what allows the system to scale from a one-file UI change to a large enterprise application without turning into an uncontrolled collection of agents.
