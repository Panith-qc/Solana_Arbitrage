import express from "express";
import { JitoMevExecutor } from "../services/jitoMevExecutor";
const router = express.Router();
let executor;
// Initialize executor
router.post("/init", async (req, res) => {
    const { rpcUrl, privateKey } = req.body;
    executor = new JitoMevExecutor(rpcUrl, privateKey);
    await executor.initialize();
    res.json({ status: "Executor initialized" });
});
// Start MEV monitoring
router.post("/start-monitoring", async (req, res) => {
    executor.startMonitoring();
    res.json({ status: "MEV monitoring started" });
});
// Stop MEV monitoring
router.post("/stop-monitoring", async (req, res) => {
    executor.stopMonitoring();
    res.json({ status: "MEV monitoring stopped" });
});
// Detect single opportunity
router.get("/detect", async (req, res) => {
    const opportunity = await executor.detectArbitrageOpportunity();
    res.json(opportunity);
});
// Execute single bundle
router.post("/execute", async (req, res) => {
    const { opportunity } = req.body;
    const result = await executor.executeArbitrageBundled(opportunity);
    res.json({ executed: result });
});
export default router;
