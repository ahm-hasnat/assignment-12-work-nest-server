const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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
    if (!taskData.task_title || !taskData.required_workers || !taskData.payable_amount) {
      return res.status(400).send({ message: "Missing required fields" });
    }

    // Construct task object
    const newTask = {
      ...taskData, // all form fields
      required_workers: Number(taskData.required_workers),
      payable_amount: Number(taskData.payable_amount),
      total_payable_amount: Number(taskData.required_workers) * Number(taskData.payable_amount),
      added_By: taskData.added_By || "unknown", // ensure email is saved
    };

    const result = await tasksCollection.insertOne(newTask);
    res.send(result);
  } catch (error) {
    console.error("Error adding task:", error);
    res.status(500).send({ message: "Failed to add task" });
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
