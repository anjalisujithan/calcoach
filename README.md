# CalCoach 🧸📆

Ever feel like you literally cannot for the life of you remember what you spent your entire day on? Students struggle with time management and this problem extends beyond academics, even in the workforce. The concrete problems this AI coach will address are: 1. Managing assignments, 2. Breaking projects into manageable subparts, 3. Work/Life balance

We start with students, but we believe this is a more generalizable problem to all working adults who want to effectively manage their life for maximum time management capabilities.

## Claude Scheduling Pipeline

Run the sample schedule set through Claude and log structured JSON suggestions.

1. Export your Anthropic key:
   - `export ANTHROPIC_API_KEY="your-key"`
2. (Optional) Limit schedules for a quick smoke test:
   - `export SCHEDULE_LIMIT=2`
3. (Optional) Override model:
   - `export CLAUDE_MODEL="claude-opus-4-6"`
4. Run:
   - `python run_claude_schedule_pipeline.py --intended-task "Study for CS 61C midterm"`

Outputs are written under `logs/claude_schedule_run_<timestamp>/`:
- `parsed_results.json` (validated structured output)
- `raw_responses.jsonl` (full API responses + extracted text)
- `errors.jsonl` (per-item failures, if any)
