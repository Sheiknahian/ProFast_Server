const express = require('express')
const cors = require('cors')
const {MongoClient, ObjectId, ServerApiVersion} = require('mongodb')
const dotenv = require('dotenv')
const admin = require("firebase-admin");

dotenv.config()

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);


const stripe = require('stripe')(process.env.STRIPE_SECRET);

const app = express();

app.use(express.json());
app.use(cors())
const PORT = process.env.PORT || 5000;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.13escam.mongodb.net/?appName=Cluster0`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

function generateTrackingId() {
  const date = new Date().toISOString().slice(0,10).replace(/-/g, "");
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `PRO-${date}-${random}`;
}
const monthNames = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec"
];
function getLast12Months() {
  const result = [];

  const now = new Date();

  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);

    result.push({
      key: `${d.getFullYear()}-${d.getMonth() + 1}`,
      month: `${monthNames[d.getMonth()]} ${d.getFullYear()}`,
      revenue: 0
    });
  }

  return result;
}

const verifyFbToken = async (req, res, next) => {
  // console.log(req.headers.authentication);
  const token = req.headers.authentication
  if(!token){
    return res.status(401).send({message: 'Unauthorized'})
  }
  try{
    const idToken = token.split(' ')[1]
    const decode = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decode.email;
    // console.log(decode);    
    next()

  }
  catch(error){
    console.log(error.message);
    res.status(401).send({ message: 'Unauthorized' });
    
  }
}

app.get('/', () => {
  res.send('Hello World');
})


async function run() {
  try {
      // Connect the client to the server	(optional starting in v4.7)
      // await client.connect();
      // await client.db("admin").command({ ping: 1 });

      const myDB = client.db('myDB');
      const parcelColls = myDB.collection('parcelDB');
      const paymentColls = myDB.collection('paymentDB');
      const userColls = myDB.collection('userDB');
      const riderColls = myDB.collection('riderDB');
      const trackingColls = myDB.collection('trackingDB');
      await paymentColls.createIndex(
        { transactionId: 1 },
        { unique: true }
      );
      console.log("Pinged your deployment. You successfully connected to MongoDB!");
      

      // Create trackings
      const logTracking = async (id, status, email) => {
        const log = {
          trackingId: id,
          email: email,
          status: status,
          trackingAt: new Date()
        }
        // console.log(log);
        
        const result = await trackingColls.insertOne(log);
        // res.send(result);
      }

      // Get trackings by user email
      app.get('/trackingId/:email', verifyFbToken, async (req, res) => {
        // console.log(req.params.email);
        let searchedText = '';
        
        if(req.params.email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        if(req.query.search){
          searchedText = req.query.search || ''
          console.log(searchedText);
          
        }
        const pipeline = [
          {
            $match: {
              email: req.params.email,
              ...(searchedText && { trackingId: searchedText })
            }
          },
          {
            $sort: {trackingAt: -1}
          },
          {
            $group: {
              _id: '$trackingId',
              latestStatus: {$first: '$status'}
            }
          }
        ]
        const result = await trackingColls.aggregate(pipeline).limit(7).toArray()
        // console.log(result);
        res.send(result);
      })

      // Join trackingColls with parcelColls
      app.get('/trackingDetails/:id', verifyFbToken, async (req, res) => {
        const id = req.params.id;
        const email = req.query.email;

        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        const query = {trackingId: id};
        const pipeline = [
          {
            $match: query
          },
          {
            $lookup: {
              from: 'parcelDB',
              localField: 'trackingId',
              foreignField: 'trackingId',
              as: 'parcel'
            }
          },
          {$unwind: '$parcel'},
          {
            $group: {
              _id: '$trackingId',
              parcel: {$first: '$parcel'},
              trackings: {
                $push: {
                  deliveryStatus: '$deliveryStatus',
                  trackingAt: '$trackingAt'
                }
              }
            }
          }
        ]
        const result = await trackingColls.aggregate(pipeline).toArray()
        // const result = await trackingColls.findOne(query)
        res.send(result)
      })

      // Get tracking by trackingId
      app.get('/trackings/:trackingId', verifyFbToken, async (req, res) => {
        const trackingId = req.params.trackingId;
        const email = req.query.email

        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        console.log(trackingId);
        let query = {};
        if(trackingId){
          query.trackingId = trackingId;
        }
        const result = await trackingColls.find(query).toArray()
        res.send(result);
      })

      // Verift admin middleware
      const verifyAdmin = async(req, res, next) => {
        try{
          const email = req.decoded_email
          // console.log(email);
          const query = {email}
          const user = await userColls.findOne(query);
          if(!user || user.role !== 'admin'){
            return res.status(403).send({message: 'Forbidden Entry'})
          }
          next()
        }
        catch(error){
          console.log(error.message); 
        }
      }

      // Get users info for manage users
      app.get('/users', verifyFbToken, verifyAdmin, async (req, res) => {
        const {search, email} = req.query;
        // console.log(search);
        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        let query = {};
        query.role = { $ne: 'rider' }
        if(search){
          query.$or = [
            {name: {$regex: search, $options: 'i'}},
            {email: {$regex: search, $options: 'i'}}
          ]
        }
        const pipeline = [
          {
            $match: query
          },
          {
            $lookup: {
              from: 'parcelDB',
              localField: 'email',
              foreignField: 'senderContact',
              as: 'userParcels'
            } 
          },
          {
            $addFields: {
              totalParcels: { $size: "$userParcels" }
            }
          }
        ]
        // const result = await userColls.find(query).toArray()
        const result = await userColls.aggregate(pipeline).toArray()
        res.send(result)
      })

      // Get total users count
      app.get('/users/count', verifyFbToken, verifyAdmin, async (req, res) => {
        const email = req.query.email
        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }
        const count = await userColls.estimatedDocumentCount({role: 'user'})
        res.send({count})
      })

      // Create new user by sign up
      app.post('/users', async (req, res) => {
        const user = req.body;
        // console.log(user);
        const existing = await userColls.findOne({email: user.email});
        if(existing){
          return res.send([]);
        }
        user.role = 'user';
        user.createdAt = new Date();
        const result = await userColls.insertOne(user);
        res.send(user);
      })

      // Get admin/user/rider role
      app.get('/users/:email/role', verifyFbToken, async (req, res) => {
        const email = req.params.email
        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }
        // console.log(email);
        const query = {email}
        const user = await userColls.findOne(query)
        res.send({role: user.role})
      })

      // Update user role by admin
      app.patch('/users/:id', verifyFbToken, verifyAdmin, async (req, res) => {
        const id = req.params.id;
        const email = req.query.email
        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        const role = req.body.role;
        const query = {_id: new ObjectId(id)};
        const update = {
          $set: {
            role: role
          }
        }
        const result = await userColls.updateOne(query, update);
        res.send(result)
      })

      // Get specific parcels by user or get all parcels
      app.get('/parcels', verifyFbToken, async (req, res)=>{
        const email = req.query.email
        const decoded_email = req.decoded_email
        const deliveryStatus = req.query.deliveryStatus;
        // console.log(deliveryStatus);

        const user = await userColls.findOne({
          email: req.decoded_email
        });
        
        if(email !== req.decoded_email && user?.role !== 'admin'){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        let query = {};
        if(email && user?.role !== 'admin'){
          query.senderContact = decoded_email
        }

        if(deliveryStatus){
          query.deliveryStatus = deliveryStatus
        }

        const result = await parcelColls.find(query).sort({createdAt: -1}).limit(10).toArray();
        res.send(result);
      })

      // Get parcel details by parcel id
      app.get('/parcels/:id', verifyFbToken, async (req, res) => {
        const id = req.params.id;
        const email = req.query.email
        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }
        const query = {_id: new ObjectId(id)};
        const result = await parcelColls.findOne(query);
        res.send(result)
      })

      // Get {date, count} of parcels
      app.get('/parcels/userDashboard/myParcels', verifyFbToken, async (req, res) => {
        const email = req.query.email;
        // console.log(email);
        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }
        const pipeline = [
          {
            $match: {
              senderContact: email,
              createdAt: {
                $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
              }
            }
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%d",
                  date: "$createdAt"
                }
              },
              count: { $sum: 1 }
            }
          }
        ]
        const result = await parcelColls.aggregate(pipeline).toArray();
        res.send(result)
      })

      // Get the total earning of a rider by {date, sum}
      app.get('/parcels/riderDashboard/revenue', verifyFbToken, async (req, res) => {
        const email = req.query.email;
        // console.log(email);
        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }
        const pipeline = [
          {
            $match: {
              riderEmail: email,
              deliveryStatus: 'parcel-delivered'
            }
          },
          {
            $group: {
              _id: {
                year: {$year: '$deliveredAt'},
                month: {$month: '$deliveredAt'}
              },
              totalRevenue: {
                $sum: '$deliveryFee'
              }
            }
          }
        ]
        const result = await parcelColls.aggregate(pipeline).toArray();
        const months = getLast12Months();

        const merged = months.map(m => {
          const found = result.find(
            r => `${r._id.year}-${r._id.month}` === m.key
          );
          // console.log(found);
          
          return {
            month: m.month,
            revenue: found ? found.totalRevenue : 0
          };
        });
        res.send(merged)
      })

      // Get the recent activities of a rider
      app.get('/parcels/riderDashboard/activities', verifyFbToken, async(req, res) => {
        const email = req.query.email

        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        const pipeline = [
          {
            $lookup: {
              from: "parcelDB",
              let: { tId: "$trackingId" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $eq: ["$trackingId", "$$tId"]
                    }
                  }
                },
                {
                  $project: {
                    _id: 0,
                    parcelName: 1,
                    senderName: 1,
                    riderEmail: 1
                  }
                }
              ],
              as: "parcel"
            }
          },
          {
            $unwind: {
              path: "$parcel",
              preserveNullAndEmptyArrays: false
            }
          },
          {
            $sort: {trackingAt: -1}
          },
          {
            $match: {
              'parcel.riderEmail': email
            }
          }
        ]
        const result = await trackingColls.aggregate(pipeline).limit(5).toArray()
        res.send(result)
      })

      // Create a new parcel
      app.post('/parcels', verifyFbToken, async (req, res)=>{
        const parcel = req.body;
        if(parcel.senderContact !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }
        parcel.createdAt = new Date();
        const trackingId = generateTrackingId()
        parcel.deliveryStatus = 'parcel-created'
        parcel.trackingId = trackingId;
        logTracking(trackingId, 'parcel-created', parcel.senderContact)
        const result = await parcelColls.insertOne(parcel);
        res.send(result);
      })

      // Delete a parcel by id
      app.delete('/parcels/:id', verifyFbToken, async (req, res)=>{
        const id = req.params.id;
        if(req.query.email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }
        // console.log(id);
        const query = {_id: new ObjectId(id)}
        const result = await parcelColls.deleteOne(query);
        res.send(result);
        
      })

      // Parcel delivery status update to assigned-rider
      app.patch('/parcels/:id', verifyFbToken, verifyAdmin, async (req, res) => {
        const id = req.params.id;
        const email = req.query.email
        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }
        const {riderId, riderName, riderEmail, trackingId, senderEmail} = req.body
        // console.log(id, riderId, riderName, riderEmail);
        
        const parcelUpdate = {
          $set: {
            deliveryStatus: 'rider-assigned',
            riderId: riderId,
            riderName: riderName,
            riderEmail: riderEmail,
            assignAt: new Date()
          }
        }
        logTracking(trackingId, 'rider-assigned', senderEmail)

        const parcelResult = await parcelColls.updateOne({_id: new ObjectId(id)}, parcelUpdate);
        
        const riderUpdate = {
          $set: {
            workStatus: 'in-delivery'
          }
        }
        const riderResult = await riderColls.updateOne({_id: new ObjectId(riderId)}, riderUpdate);
        res.send(riderUpdate, parcelResult)
      })

      // Get parcel by delivery status
      app.get('/parcels/rider/:email', verifyFbToken, async (req, res) => {
        const {deliveryStatus} = req.query
        const email = req.params.email
        // console.log(email, deliveryStatus);
        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }
        const query = {};
        if (deliveryStatus === 'parcel-delivered') {
          query.riderEmail = email
          query.deliveryStatus = 'parcel-delivered';
        }
        else {
          query.riderEmail = email
          query.deliveryStatus = { $ne: 'parcel-delivered' };
        }
        const result = await parcelColls.find(query).sort({createdAt: -1}).toArray();
        res.send(result)
      })

      // Update parcel delivery status by rider
      app.patch('/parcel/rider/:id/status-update', verifyFbToken, async (req, res) => {
        const parcelId = req.params.id;
        const {deliveryStatus, trackingId, riderEmail, senderEmail, deliveryFee} = req.body

        if(riderEmail !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }
        const query = {_id: new ObjectId(parcelId)}

        if (deliveryStatus === 'parcel-delivered') {  //For Delivery Status Update
          const riderResult = await riderColls.updateOne({riderEmail}, {
            $set: {
              workStatus: 'available'
            }
          })
          logTracking(trackingId, deliveryStatus, senderEmail)
          const result = await parcelColls.updateOne(query, {
            $set: {
              deliveryStatus: deliveryStatus,
              deliveryFee: deliveryFee,
              deliveredAt: new Date()
            }
          })
          return res.send(result)
        }

        update = {
          $set: {
            deliveryStatus: deliveryStatus
          }
        }
        logTracking(trackingId, deliveryStatus, senderEmail)

        const result = await parcelColls.updateOne(query, update);
        res.send(result)
      })

      // Get user parcels stats by {deliveryStatus, count}
      app.get('/parcels/deliveryStatus/stat', verifyFbToken, async (req, res) => {
        const email = req.query.email

        const user = await userColls.findOne({
          email: req.decoded_email
        });

        
        if(email !== req.decoded_email && user?.role !== 'admin'){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        let matchItem = {}
        if(email && user?.role !== 'admin'){
          matchItem = {senderContact: email}
        }
        const pipeline = [
          {
            $match: matchItem
          },
          {
            $group: {
              _id: '$deliveryStatus',
              count: {$sum: 1}
            }
          }
        ]
        const result = await parcelColls.aggregate(pipeline).toArray()
        res.send(result);
      })

      // Get the total revenue
      app.get('/payments/price/totalReveue', verifyFbToken, verifyAdmin, async (req, res) => {
        const email = req.query.email
        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        const pipeline = [
          {
            $match: {
              paidAt: {
                $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
              }
            }
          },
          
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%d",
                  date: "$paidAt"
                }
              },
              revenue: { $sum: '$amount' }
            }
          },
          {
            $sort: {paidAt: -1}
          },
        ]
        const result = await paymentColls.aggregate(pipeline).toArray();
        res.send(result);
      })

      // Create checkout session with stripe
      app.post('/create-checkout-session', verifyFbToken, async (req, res) => {
        const paymentInfo = req.body
        // console.log(paymentInfo.parcelId);
        
        if(paymentInfo.senderEmail !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: 'USD',
                product_data: {
                  name: paymentInfo.parcelName,
                },
                unit_amount: paymentInfo.price*100
              },
              quantity: 1,
            },
          ],
          metadata: {
            parcelId: paymentInfo.parcelId,
            parcelName: paymentInfo.parcelName,
            senderName: paymentInfo.senderName,
            trackingId: paymentInfo.trackingId
          },
          customer_email: paymentInfo.senderEmail,
          mode: 'payment',
          success_url: `http://localhost:5173/success-page?session_id={CHECKOUT_SESSION_ID}`,
        });
        res.send({url: session.url});
      });

      // Update payment status to paid and delivery status to confirmed-parcel
      app.patch('/payment-success', verifyFbToken, async (req, res)=>{
        const sessionId = req.query.sessionId
        // console.log(sessionId);
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        // console.log(session);

        if(session.customer_email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        const transQuery = {transactionId: session.payment_intent}
        const transExist = await paymentColls.findOne(transQuery)
        console.log(session);
        
        if(transExist){
          return res.send({
            status: true,
            transactionId: session.payment_intent,
            trackingId: transExist.trackingId,
            amount: session.amount_subtotal/100,
            currency: session.currency,
            email: session.customer_details.email,
            name: session.metadata.senderName,
            parcelName: session.metadata.parcelName
          })
        }
  
        if(session.payment_status === 'paid'){
          const id = session.metadata.parcelId
          const query = {_id: new ObjectId(id)}
          const hasTransactionId = await parcelColls.findOne(query)
          if (hasTransactionId.transactionId) {
            return res.send({
              trackingId: hasTransactionId.trackingId,
              transactionId: hasTransactionId.transactionId
            })
          }

          const update = {
            $set:{
              isPaid: session.payment_status,
              trackingId: session.metadata.trackingId,
              deliveryStatus: 'parcel-confirmed',
              transactionId: session.payment_intent,
            }
          }
          logTracking(session.metadata.trackingId, 'parcel-confirmed', session.customer_email)

          // console.log(session);
          const result = await parcelColls.updateOne(query, update)
          const payment = {
            senderName: session.metadata.senderName,
            amount: session.amount_total/100,
            parcelName: session.metadata.parcelName,
            email: session.customer_email,
            currency: session.currency,
            parcelId: session.metadata.parcelId,
            transactionId: session.payment_intent,
            paymentStatus: session.payment_status,
            trackingId: session.metadata.trackingId,
            paidAt: new Date()
          }
          try{
            const paymentResult = await paymentColls.insertOne(payment);
          }
          catch(error){       
            if (error.code === 11000) {
              return res.send({
                message: "Payment already processed",
                duplicate: true
              });
            }
          }
          res.send({
            status: true,
            payment: payment,
            transactionId: session.payment_intent,
            trackingId: session.metadata.trackingId,
            amount: session.amount_subtotal/100,
            currency: session.currency,
            email: session.customer_details.email,
            name: session.metadata.senderName,
            parcelName: session.metadata.parcelName
          })
        } 
      })

      // Get users payment history for
      app.get('/payment-history', verifyFbToken, async (req, res)=>{
        const email = req.query.email;

        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        const query = {email: email};
        const result = await paymentColls.find(query).sort({paidAt: -1}).toArray();
        
        // console.log(result);
        res.send(result);
      })

      // Get riders for assign
      app.get('/riders', verifyFbToken, verifyAdmin, async (req, res) => {
        // const query = {status: 'pending'};

        const {status, workStatus, district, email} = req.query;

        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        let query = {}
        // console.log();
        if(status && workStatus && district){
          query.status = status;
          query.workStatus = workStatus;
          query.riderDistrict = district;
        }
        const result = await riderColls.find(query).sort({createdAt: -1}).toArray()
        res.send(result)
      })

      // Get total rider count
      app.get('/riders/count', verifyFbToken, verifyAdmin, async (req, res) => {
        const email = req.query.email
        
        const user = await userColls.findOne({
          email: req.decoded_email
        });

        if(email !== req.decoded_email && user?.role !== 'admin'){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        const count = await riderColls.estimatedDocumentCount({status: 'Approved'})
        res.send({count})
      })

      // Get rider stats by {deliveryStatus, count}
      app.get('/rider/stats/status/:email', verifyFbToken, async (req, res) => {
        const email = req.params.email
        console.log(req.decoded_email);
        
        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }
        
        const pipeline = [
          {
            $match: {
              riderEmail: email,
            }
          },
          {
            $group: {
              _id: '$deliveryStatus',
              count: {$sum: 1}
            }
          },
        ]
        const result = await parcelColls.aggregate(pipeline).toArray();
        res.send(result)
      })

      // Get the overall earning of a rider
      app.get('/rider/stats/revenue/:email', verifyFbToken, async (req, res) => {
        const email = req.params.email
        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }
        const pipeline = [
          {
            $match: {
              riderEmail: email,
              deliveryStatus: 'parcel-delivered'
            }
          },
          {
            $group: {
              _id: null,
              fee: {$sum: '$deliveryFee'}
            }
          }
        ]
        const result = await parcelColls.aggregate(pipeline).toArray()
        res.send(result)
      })

      // Create a new rider request
      app.post('/riders', async (req, res) => {
        const email = req.query.email
        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Unauthorized Access'})
        }

        const rider = req.body;
        rider.status = 'pending';
        rider.createdAt = new Date();
        const result = await riderColls.insertOne(rider);
        res.send(result)
      })

      // Approve or reject action
      app.patch('/riders', verifyFbToken, verifyAdmin, async (req, res) => {
        const {id, email} = req.query;
        const user = await userColls.findOne({
          email: req.decoded_email
        });
        if(email !== req.decoded_email && user?.role !== 'admin'){
          return res.status(403).send({message: 'Unauthorized Access'})
        }
        const action = req.body.action;
        let status, role, workStatus;
        if(action === 'Approve'){
          status = 'Approved'
          role = 'rider'
          workStatus = 'available'
        }
        else if(action === 'Reject'){
          status = 'Rejected'
        }
        else if(action === 'Remove'){
          status = 'Removed'
          role = 'user'
          workStatus = 'not-available'
        } 
        // console.log(role, email);
        // console.log(id);
        const query = {_id: new ObjectId(id)};
        const update = {
          $set: {
            status: status,
            workStatus: workStatus,
            actionedAt: new Date()
          }
        }
        const result = await riderColls.updateOne(query, update)
        const updateRole = {
          $set: {
            role: role
          }
        }
        const roleResult = await userColls.updateOne({email}, updateRole)
        res.send(result)
      })


  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.listen(PORT, (req, res)=>{
          console.log(`Server Connected On Port: ${PORT}`);
      })

