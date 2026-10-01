#!/bin/bash
# Troca/adiciona o endereço do Missão Finanças, com a trava que evita o erro clássico:
# ligar a regra do Traefik ANTES do DNS apontar pra cá faz o Let's Encrypt falhar em laço
# e consumir a cota de certificados compartilhada com os outros 8 subdomínios
# (lição registrada em 19/09/2026, no painel do PokéMobile).
#
# Uso:  ./trocar-endereco.sh workprog.pro www.workprog.pro
#       ./trocar-endereco.sh financas.workprog.pro
#
# O endereço antigo (poke.workprog.pro) continua funcionando de propósito: o Gabriel e a
# Luana já estão logados por ele, e link de convite já enviado aponta pra lá.

set -euo pipefail
IP_DA_VPS="179.198.111.88"
YAML="/root/missao-financas.yaml"
NOVOS=("$@")

if [ ${#NOVOS[@]} -eq 0 ]; then
  echo "uso: $0 <endereço> [outro-endereço...]"; exit 1
fi

echo "1) Conferindo o DNS de cada endereço novo…"
for d in "${NOVOS[@]}"; do
  ip=$(dig +short "$d" A | tail -1)
  if [ "$ip" != "$IP_DA_VPS" ]; then
    echo "   ❌ $d aponta para '${ip:-nada}' — precisa ser $IP_DA_VPS"
    echo
    echo "   NADA foi alterado. Crie/ajuste o registro A no painel do domínio e rode de novo."
    echo "   (Ligar a regra agora faria o Let's Encrypt falhar em laço e gastar a cota dos"
    echo "    outros subdomínios.)"
    exit 1
  fi
  echo "   ✅ $d -> $ip"
done

echo "2) Guardando cópia do arquivo atual…"
cp "$YAML" "$YAML.bak-$(date +%Y%m%d-%H%M%S)"

echo "3) Montando a regra com o endereço antigo + os novos…"
REGRA="Host(\`poke.workprog.pro\`)"
for d in "${NOVOS[@]}"; do REGRA="$REGRA || Host(\`$d\`)"; done
python3 - "$YAML" "$REGRA" <<'PY'
import re,sys
arq,regra=sys.argv[1],sys.argv[2]
s=open(arq,encoding='utf-8').read()
novo=re.sub(r'(traefik\.http\.routers\.missao_financas_app\.rule=).*', r'\1'+regra, s)
assert novo!=s, 'não achei a linha da regra no yaml'
open(arq,'w',encoding='utf-8').write(novo)
print('   regra:', regra)
PY

echo "4) Aplicando no Docker Swarm…"
docker stack deploy -c "$YAML" missao >/dev/null
docker service update --force missao_missao_financas_app >/dev/null
echo "   aguardando o certificado do Let's Encrypt (pode levar até 1 minuto)…"

echo "5) Conferindo no ar, por HTTPS de verdade…"
for d in poke.workprog.pro "${NOVOS[@]}"; do
  ok=""
  for tentativa in $(seq 1 12); do
    codigo=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$d/" || true)
    if [ "$codigo" = "200" ]; then ok="sim"; break; fi
    sleep 5
  done
  if [ "$ok" = "sim" ]; then
    echo "   ✅ https://$d -> 200 (certificado válido)"
  else
    echo "   ⚠️  https://$d ainda não respondeu 200 (último código: ${codigo:-nenhum})."
    echo "      Se acabou de mexer no DNS, espere alguns minutos e rode: curl -I https://$d/"
  fi
done
echo
echo "Pronto. O endereço antigo (poke.workprog.pro) continua valendo."
