const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const Stripe = require("stripe");

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.xkximz0.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const workersCollection = client.db("workersDb").collection("allWorkers");
    const usersCollection = client.db("allUsersDb").collection("allUsers");
    const tasksCollection = client.db("allTasksDB").collection("allTasks");

    app.post("/allUsers", async (req, res) => {
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.status(201).json(result);
    });
    app.post("/allWorkers", async (req, res) => {
      const user = req.body;
      const result = await workersCollection.insertOne(user);
      res.status(201).json(result);
    });

    app.post("/allTasks", async (req, res) => {
      try {
        const tasksCollection = client.db("allTasksDB").collection("allTasks");
        const taskData = req.body; // everything from form

        // Basic validation
        if (
          !taskData.task_title ||
          !taskData.required_workers ||
          !taskData.payable_amount
        ) {
          return res.status(400).send({ message: "Missing required fields" });
        }

        // Construct task object
        const newTask = {
          ...taskData, // all form fields
          required_workers: Number(taskData.required_workers),
          payable_amount: Number(taskData.payable_amount),
          total_payable_amount:
            Number(taskData.required_workers) * Number(taskData.payable_amount),
          added_By: taskData.added_By || "unknown", // ensure email is saved
        };

        const result = await tasksCollection.insertOne(newTask);
        res.send(result);
      } catch (error) {
        console.error("Error adding task:", error);
        res.status(500).send({ message: "Failed to add task" });
      }
    });

    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amount } = req.body; // amount in cents
        if (!amount || amount <= 0) {
          return res.status(400).json({ error: "Invalid amount" });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error("Stripe create-payment-intent error:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.post("/save-payment", async (req, res) => {
      try {
        const { paid_by, email, price, transactionId, packageName, coins } =
          req.body;
         
         const usersCollection = client.db("allUsersDb").collection("allUsers"); 
        const paymentsCollection = client
          .db("paymentsDb")
          .collection("payments");
        const paymentData = {
          paid_by,
          email,
          packageName,
          price,
          coins,
          transactionId,
          date: new Date(),
        };

        const result = await paymentsCollection.insertOne(paymentData);
        res.json({ success: true, result });
        await usersCollection.updateOne(
  { email: email },
  { $inc: { coins: coins } }, // increments coins by purchased amount
  { upsert: true }            // creates user if not exist
);
      } catch (error) {
        console.error("Save payment error:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // Create or update user by email (upsert)
    app.put("/allUsers/upsert/:email", async (req, res) => {
      const email = req.params.email;
      const userInfo = req.body;

      const result = await usersCollection.updateOne(
        { email }, // filter
        { $set: userInfo }, // update fields
        { upsert: true } // create if not exists
      );

      res.json(result);
    });
    app.put("/allWorkers/upsert/:email", async (req, res) => {
      const email = req.params.email;
      const userInfo = req.body;

      const result = await workersCollection.updateOne(
        { email }, // filter
        { $set: userInfo }, // update fields
        { upsert: true } // create if not exists
      );

      res.json(result);
    });

    // Update a task by ID
    app.put("/allTasks/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const { task_title, task_detail, required_workers, totalPayable } =
          req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid task ID" });
        }

        const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
        if (!task) return res.status(404).json({ message: "Task not found" });

        const user = await usersCollection.findOne({ email: task.added_By });
        if (!user) return res.status(404).json({ message: "User not found" });

        const oldTotal = Number(task.total_payable_amount || 0);
        const newTotal = Number(totalPayable);
        const diff = newTotal - oldTotal; // How much coins will change

        // ❌ Check if user has enough coins before updating
        if (diff > 0 && user.coins < diff) {
          return res.status(400).json({ message: "Insufficient coins" });
        }

        // ✅ Update task
        const updateData = {
          task_title,
          task_detail,
          required_workers: Number(required_workers),
          total_payable_amount: newTotal,
        };

        await tasksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        // ✅ Update user's coins
        if (diff !== 0) {
          await usersCollection.updateOne(
            { email: task.added_By },
            { $inc: { coins: -diff } } // Subtract if diff>0, add if diff<0
          );
        }

        res.json({
          success: true,
          message: "Task updated successfully",
          updated: updateData,
        });
      } catch (error) {
        console.error("Error updating task:", error);
        res.status(500).json({ message: "Failed to update task" });
      }
    });

    app.get("/allUsers", async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    app.get("/best-workers", async (req, res) => {
      const bestWorkers = await workersCollection
        .find({ role: "worker" })
        .sort({ coins: -1 }) // sort descending
        .limit(6)
        .toArray();
      res.send(bestWorkers);
    });

    app.get("/allUsers/:email/role", async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.json({ role: user.role }); // worker or buyer
    });

    app.get("/allUsers/:email", async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      if (!user) return res.status(404).json(null);
      res.json(user);
    });

    // get allTasks

    app.get("/allTasks", async (req, res) => {
      const buyerEmail = req.query.buyer;
      const query = buyerEmail ? { buyer: buyerEmail } : {};
      const tasks = await tasksCollection.find(query).toArray();
      res.json(tasks);
    });

    app.get("/payments/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const paymentsCollection = client
          .db("paymentsDb")
          .collection("payments");

        const payments = await paymentsCollection
          .find({ email })
          .sort({ date: -1 }) // latest payments first
          .toArray();

        res.json(payments);
      } catch (error) {
        console.error("Fetch payments error:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.delete("/allTasks/:id", async (req, res) => {
      try {
        const id = req.params.id;

        // Find the task before deleting
        const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
        if (!task) {
          return res.status(404).json({ message: "Task not found" });
        }

        // Delete the task
        const result = await tasksCollection.deleteOne({
          _id: new ObjectId(id),
        });
        if (result.deletedCount === 0) {
          return res.status(404).json({ message: "Failed to delete task" });
        }

        // Refund coins (get user from allUsers)
        const refundAmount = Number(task.total_payable_amount) || 0;
        const buyerEmail = task.added_By;

        const user = await usersCollection.findOne({ email: buyerEmail });
        if (!user) {
          return res.status(404).json({ message: "User not found for refund" });
        }

        const updatedCoins = (user.coins || 0) + refundAmount;

        await usersCollection.updateOne(
          { email: buyerEmail },
          { $set: { coins: updatedCoins } }
        );

        res.json({
          message: "Task deleted successfully, coins refunded",
          refund: refundAmount,
          updatedCoins,
        });
      } catch (error) {
        console.error("Error deleting task:", error);
        res.status(500).json({ message: "Failed to delete task" });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Looking for money in server..!");
});

app.listen(port, () => {
  console.log(`WorkNest server is running on port ${port}`);
});
