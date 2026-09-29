#!/bin/bash
cd /home/zhoujie22/river2_0/evol_bench/SkillLearnBench
exec python3 /home/zhoujie22/river2_0/evol_bench/SkillsBench/code/skillsbench_env_server.py \
  --tasks-root /home/zhoujie22/river2_0/evol_bench/SkillLearnBench/code/vendor/skilllearnbench-official \
  --profile skilllearnbench \
  --port 8732 \
  --log /home/zhoujie22/river2_0/evol_bench/SkillLearnBench/results/_mechanism/lifecycle-collab2.jsonl \
  --exec-proxy http://172.17.0.1:7893
