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
    const subCollection = client.db("submissionDB").collection("allSubmits");
    const withdrawCollection = client
      .db("withdrawDB")
      .collection("allWithdraws");
    const paymentsCollection = client.db("paymentsDb").collection("payments");

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
        const usersCollection = client.db("allUsersDb").collection("allUsers");
        const taskData = req.body;

        console.log(taskData);

        // Fetch latest user data
        const buyer = await usersCollection.findOne({
          email: taskData.buyer_email,
        });
        if (!buyer) return res.status(404).send({ message: "User not found" });

        const total_payable_amount =
          Number(taskData.required_workers) * Number(taskData.payable_amount);

        if (buyer.coins < total_payable_amount) {
          return res.status(400).send({ message: "Insufficient coins" });
        }

        // Deduct coins
        await usersCollection.updateOne(
          { email: taskData.buyer_email },
          { $inc: { coins: -total_payable_amount } }
        );

        const newTask = {
          ...taskData,
          required_workers: Number(taskData.required_workers),
          currently_required_workers: Number(taskData.required_workers),
          payable_amount: Number(taskData.payable_amount),
          total_payable_amount,
          added_By: taskData.added_By,
        };

        const result = await tasksCollection.insertOne(newTask);
        res.send(result);
      } catch (error) {
        console.error(error);
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
          type_of_payment: "made",
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
          { upsert: true } // creates user if not exist
        );
      } catch (error) {
        console.error("Save payment error:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.post("/submissions/approve/:id", async (req, res) => {
      const submissionId = req.params.id;

      try {
        const submission = await subCollection.findOne({
          _id: new ObjectId(submissionId),
        });
        if (!submission)
          return res.status(404).json({ message: "Submission not found" });

        // 1. Add entry to payment collection
        const paymentData = {
          payment_type: "give",
          worker_name: submission.worker_name,
          task_title: submission.task_title,
          coins: submission.payable_amount,
          submission_date: submission.current_date,
          approval_date: new Date(),
          task_id: submission.task_id,
          worker_email: submission.worker_email,

          buyer_name: submission.buyer_name,

          buyer_email: submission.buyer_email,
        };
        await paymentsCollection.insertOne(paymentData);

        // 2. Update worker coins in allUsers collection
        await usersCollection.updateOne(
          { email: submission.worker_email },
          { $inc: { coins: submission.payable_amount } }
        );

        // 3. Update submission status to 'approved'
        await subCollection.updateOne(
          { _id: new ObjectId(submissionId) },
          { $set: { status: "approved" } }
        );

        // 4. Decrease required_workers in allTasks
        await tasksCollection.updateOne(
          { _id: new ObjectId(submission.task_id) },
          { $inc: { currently_required_workers: -1 } }
        );

        res.status(200).json({ message: "Submission approved successfully" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Approval failed" });
      }
    });

    app.post("/allSubmits", async (req, res) => {
      try {
        const submission = req.body;

        const submissionData = {
          ...submission,
          current_date: new Date(),
          status: "pending",
        };

        // Insert the submission
        const result = await subCollection.insertOne(submissionData);

        res.json({ success: true, result });
      } catch (error) {
        console.error("Error saving submission:", error);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    // POST /withdrawals
    app.post("/withdrawals", async (req, res) => {
      try {
        const {
          worker_email,
          worker_name,
          withdrawal_coin,
          withdrawal_amount,
          payment_system,
          account_number,
        } = req.body;

        if (
          !worker_email ||
          !withdrawal_coin ||
          !withdrawal_amount ||
          !payment_system ||
          !account_number
        ) {
          return res.status(400).json({ message: "All fields are required" });
        }

        // Insert withdrawal request
        const withdrawal = {
          worker_email,
          worker_name,
          withdrawal_coin,
          withdrawal_amount,
          payment_system,
          account_number,
          withdraw_date: new Date(),
          status: "pending",
        };

        const result = await withdrawCollection.insertOne(withdrawal);

        res.json({ success: true, insertedId: result.insertedId });
      } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // Create or update user by email (upsert)
    // Upsert user in allUsers
   // Users
// Create user if not exist
// Users
app.post("/allUsers", async (req, res) => {
  
   
try{
    // User does not exist → create full document
     await usersCollection.insertOne({
      name: user.name,
      email: user.email,
      provider: user.provider,
      photoURL: user.photoURL,
      role: user.role || "worker",
      coins: user.coins || 10,
      created_at: new Date().toISOString(),
      last_log_in: new Date().toISOString(),
    });

    res.status(201).json({ message: "New user created", result });
  } catch (err) {
    console.error("Error creating/updating user:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Workers
app.post("/allWorkers", async (req, res) => {
  try {
    
       await workersCollection.insertOne({
      name: user.name,
      email: user.email,
      provider: user.provider,
      photoURL: user.photoURL,
      role: "worker",
      coins: 10,
      created_at: new Date().toISOString(),
      last_log_in: new Date().toISOString(),
    });

    res.status(201).json({ message: "New worker created", result });
  } catch (err) {
    console.error("Error creating/updating worker:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Update last_log_in for an existing user
app.patch("/allUsers/:email", async (req, res) => {
  try {
    const email = req.params.email;

    const result = await usersCollection.updateOne(
      { email },
      { $set: { last_log_in: new Date().toISOString() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ success: true, message: "Last login updated" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// Update last_log_in for an existing worker
app.patch("/allWorkers/:email", async (req, res) => {
  try {
    const email = req.params.email;

    const result = await workersCollection.updateOne(
      { email },
      { $set: { last_log_in: new Date().toISOString() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Worker not found" });
    }

    res.json({ success: true, message: "Last login updated" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});


    // Update a task by ID
    app.put("/allTasks/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const {
          task_title,
          task_detail,
          currently_required_workers,
          totalPayable,
        } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid task ID" });
        }

        const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
        if (!task) return res.status(404).json({ message: "Task not found" });

        const user = await usersCollection.findOne({ email: task.buyer_email });
        if (!user) return res.status(404).json({ message: "User not found" });

        const oldTotal = Number(task.total_payable_amount || 0);
        const newTotal = Number(totalPayable);
        const workerOldTotal = Number(task.currently_required_workers || 0);
        const workerNewTotal = Number(currently_required_workers);
        const diff = newTotal - oldTotal; // How much coins will change
        const workerDiff = workerNewTotal - workerOldTotal; // How much coins will change

        // ❌ Check if user has enough coins before updating
        if (diff > 0 && user.coins < diff) {
          return res.status(400).json({ message: "Insufficient coins" });
        }

        // ✅ Update task
        const updateData = {
          task_title,
          task_detail,
          currently_required_workers: Number(currently_required_workers),
          total_payable_amount: newTotal,
        };

        await tasksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { required_workers: workerDiff } }
        );
        await tasksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        // ✅ Update user's coins
        if (diff !== 0) {
          await usersCollection.updateOne(
            { email: task.buyer_email },
            { $inc: { coins: diff } } // Subtract if diff>0, add if diff<0
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

    app.put("/allWithdraws/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid withdrawal ID" });
        }

        // Find the withdrawal request
        const withdraw = await withdrawCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!withdraw) {
          return res
            .status(404)
            .json({ message: "Withdrawal request not found" });
        }

        if (status === "approved") {
          // Deduct coins from user
          const user = await usersCollection.findOne({
            email: withdraw.worker_email,
          });
          if (!user) {
            return res.status(404).json({ message: "User not found" });
          }

          // Deduct coins
          await usersCollection.updateOne(
            { email: withdraw.worker_email },
            { $inc: { coins: -withdraw.withdrawal_coin } }
          );

          // Add payment record
          const paymentData = {
            type_of_payment: "get",
            worker_email: withdraw.worker_email,
            worker_name: withdraw.worker_name,
            withdrawal_coin: withdraw.withdrawal_coin,
            payment_amount: withdraw.withdrawal_amount,
            payment_system: withdraw.payment_system,
            account_number: withdraw.account_number,

            payment_date: new Date(),
          };

          await paymentsCollection.insertOne(paymentData);
        }

        // Update withdrawal status
        await withdrawCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );

        res.json({
          message: "Withdrawal approved and payment recorded successfully",
        });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.patch("/submissions/reject/:id", async (req, res) => {
      const submissionId = req.params.id;

      try {
        if (!ObjectId.isValid(submissionId)) {
          return res.status(400).json({ message: "Invalid submission ID" });
        }

        const result = await subCollection.updateOne(
          { _id: new ObjectId(submissionId) },
          { $set: { status: "rejected" } }
        );

        if (result.modifiedCount === 0) {
          return res
            .status(404)
            .json({ message: "Submission not found or already rejected" });
        }

        res.json({
          success: true,
          message: "Submission rejected successfully",
        });
      } catch (err) {
        console.error("Error rejecting submission:", err);
        res.status(500).json({ message: "Failed to reject submission" });
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

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  res.json({ role: user.role });
});


    app.get("/allUsers/:email", async (req, res) => {
      const user = await usersCollection.findOne({ email: req.params.email });
      if (!user) return res.status(404).json(null);
      res.json(user);
    });

    // get allTasks

    app.get("/allTasks", async (req, res) => {
      const buyerEmail = req.query.buyer;
      const query = buyerEmail ? { buyer_email: buyerEmail } : {};
      const tasks = await tasksCollection.find(query).toArray();
      res.json(tasks);
    });
    app.get("/allTasks/:id", async (req, res) => {
      const id = req.params.id;
      const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
      res.json(task);
    });
    app.get("/allTasks/buyer/:email", async (req, res) => {
      const buyerEmail = req.params.email;
      const tasks = await tasksCollection
        .find({ buyer_email: buyerEmail })
        .toArray();
      res.json(tasks);
    });
    // Assuming you have Express and a MongoDB collection set up
    app.get("/payments", async (req, res) => {
      try {
        const payments = await paymentsCollection.find().toArray();
        res.status(200).json(payments);
      } catch (err) {
        console.error("Failed to fetch payments:", err);
        res.status(500).json({ message: "Failed to fetch payments" });
      }
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

    app.get("/allSubmits/:taskId/:workerEmail", async (req, res) => {
      try {
        const { taskId, workerEmail } = req.params; // get both from URL params

        if (!workerEmail) {
          return res.status(400).json({ message: "Worker email required" });
        }

        const submission = await subCollection.findOne({
          task_id: taskId,
          worker_email: workerEmail,
          status: "pending",
        });

        res.json({ submitted: !!submission });
      } catch (error) {
        console.error("Error fetching submission:", error);
        res.status(500).json({ success: false, message: error.message });
      }
    });
    // Get all submissions for a worker
    app.get("/mySubmits/:workerEmail", async (req, res) => {
      try {
        const { workerEmail } = req.params;

        const submissions = await subCollection
          .find({ worker_email: workerEmail })
          .sort({ current_date: -1 }) // newest first
          .toArray();

        res.json(submissions);
      } catch (error) {
        console.error("Error fetching submissions:", error);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.get("/allWithdraws", async (req, res) => {
      const withDraws = await withdrawCollection.find().toArray();
      res.send(withDraws);
    });

    app.get("/submissions", async (req, res) => {
      try {
        const submissions = await subCollection.find({}).toArray();
        res.status(200).json(submissions);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to fetch submissions" });
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
        const buyerEmail = task.buyer_email;

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

    app.delete("/allUsers/:id", async (req, res) => {
      try {
        const userId = req.params.id;

        if (!ObjectId.isValid(userId)) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid user ID" });
        }

        const result = await usersCollection.deleteOne({
          _id: new ObjectId(userId),
        });

        if (result.deletedCount === 0) {
          return res
            .status(404)
            .json({ success: false, message: "User not found" });
        }

        res.json({ success: true, message: "User deleted successfully" });
      } catch (error) {
        console.error("Error deleting user:", error);
        res.status(500).json({ success: false, message: "Server error" });
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
