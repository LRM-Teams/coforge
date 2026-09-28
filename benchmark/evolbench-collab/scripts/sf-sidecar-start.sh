#!/bin/bash
cd /home/zhoujie22/river2_0/evol_bench/SkillFlow
exec python3 /home/zhoujie22/river2_0/evol_bench/SkillsBench/code/skillsbench_env_server.py \
  --tasks-root /home/zhoujie22/river2_0/evol_bench/SkillFlow/data/SkillFlow-Task/test_tasks \
  --profile skillflow \
  --port 8733 \
  --log /home/zhoujie22/river2_0/evol_bench/SkillFlow/results/lifecycle-collab1.jsonl \
  --exec-proxy http://172.17.0.1:7893
