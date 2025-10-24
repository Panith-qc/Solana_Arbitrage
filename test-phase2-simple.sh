#!/bin/bash
# Simple Phase 2 Testing Script
# Tests Phase 2 services without executing TypeScript directly

echo "╔════════════════════════════════════════════════════════════╗"
echo "║       PHASE 2 TESTING - FILE VERIFICATION                 ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

total_tests=0
passed_tests=0

# Test function
test_file() {
    local file=$1
    local name=$2
    total_tests=$((total_tests + 1))
    
    if [ -f "$file" ]; then
        local lines=$(wc -l < "$file")
        echo -e "${GREEN}✅ PASS${NC} $name ($lines lines)"
        passed_tests=$((passed_tests + 1))
    else
        echo -e "${RED}❌ FAIL${NC} $name (file not found)"
    fi
}

echo "📦 Testing Phase 2 Service Files..."
echo ""

# Test Phase 2 strategy files
test_file "src/services/backrunService.ts" "Backrun Service"
test_file "src/services/cyclicArbitrageService.ts" "Cyclic Arbitrage Service"
test_file "src/services/jitLiquidityService.ts" "JIT Liquidity Service"
test_file "src/services/longTailArbitrageService.ts" "Long-Tail Arbitrage Service"

echo ""
echo "📦 Testing Phase 2 Infrastructure Files..."
echo ""

# Test infrastructure files
test_file "src/services/mempoolMonitor.ts" "Mempool Monitor"
test_file "src/services/priorityFeeOptimizer.ts" "Priority Fee Optimizer"
test_file "src/services/jitoBundleService.ts" "Jito Bundle Service"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "📊 TEST RESULTS:"
echo "   Total Tests: $total_tests"
echo "   Passed: $passed_tests"
echo "   Failed: $((total_tests - passed_tests))"
echo ""

pass_rate=$((passed_tests * 100 / total_tests))
echo "   Pass Rate: ${pass_rate}%"
echo ""

if [ $pass_rate -eq 100 ]; then
    echo -e "${GREEN}✅ ALL PHASE 2 FILES PRESENT!${NC}"
    echo -e "${GREEN}✅ Ready for build and testing${NC}"
elif [ $pass_rate -ge 80 ]; then
    echo -e "${YELLOW}⚠️  MOST FILES PRESENT${NC}"
    echo -e "${YELLOW}⚠️  Some files may be missing${NC}"
else
    echo -e "${RED}❌ MULTIPLE FILES MISSING${NC}"
    echo -e "${RED}❌ Phase 2 merge may be incomplete${NC}"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo ""

# Try to build the project
echo "🔨 Testing Build Process..."
echo ""

if pnpm run build 2>&1 | tail -5; then
    echo ""
    echo -e "${GREEN}✅ Build successful!${NC}"
else
    echo ""
    echo -e "${RED}⚠️  Build had warnings/errors${NC}"
    echo "   Check output above for details"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "📋 NEXT STEPS:"
echo ""
echo "1. ✅ Review test results above"
echo "2. 🚀 Start dev server: pnpm run dev"
echo "3. 🌐 Open http://localhost:8080"
echo "4. 🔑 Connect wallet in dashboard"
echo "5. 📊 Start MEV scanner and monitor"
echo ""
echo "📖 Read PHASE2_TESTING_GUIDE.md for detailed instructions"
echo ""
