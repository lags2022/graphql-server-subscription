import "./db.js";
import Person from "./models/person.js";
import User from "./models/user.js";
import { ApolloServer } from "@apollo/server";
import jwt from "jsonwebtoken";
import { startStandaloneServer } from "@apollo/server/standalone";
import * as dotenv from "dotenv";
dotenv.config();
import { GraphQLError } from "graphql";
import { expressMiddleware } from "@apollo/server/express4";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/lib/use/ws";
import { PubSub } from "graphql-subscriptions";

const pubsub = new PubSub();

const SUBSCRIPTION_EVENTS = {
  PERSON_ADDED: "CUALQUIER_NOMBRE",
};

// The GraphQL schema
const typeDefinitions = `#graphql
  enum YesNo {
    YES
    NO
  }

  type Address {
    street: String!
    city: String!
  }

  type Person {
    name: String!
    phone: String
    address: Address!
    id: ID!
  }

  type User {
    username: String!
    friends: [Person!]!
    id: ID!
  }

  type Token {
    value: String!
  }

  type Query {
    personCount: Int!
    allPersons(phone: YesNo): [Person!]!
    findPerson(name: String!): Person
    me: User
  }

  type Mutation {
    addPerson(
      name: String!
      phone: String
      street: String!
      city: String!
    ): Person
    editNumber(name: String!, phone: String!): Person
    createUser(username: String!): User
    login(username: String!, password: String!): Token
    addAsFriend(name: String!): User
  }

  type Subscription {
    personAdded: Person!
  } 

`;

const resolvers = {
  Query: {
    personCount: () => Person.collection.countDocuments(),
    allPersons: async (root, args) => {
      if (!args.phone) return Person.find({});
      return Person.find({ phone: { $exists: args.phone === "YES" } });
    },
    findPerson: async (root, args) => {
      const { name } = args;
      return Person.findOne({ name });
    },
    me: (root, args, context) => {
      return context.currentUser;
    },
  },
  Mutation: {
    addPerson: async (root, args, context) => {
      const { currentUser } = context;
      if (!currentUser) throw new GraphQLError("not authenticated");
      const person = new Person({ ...args });
      try {
        await person.save();
        currentUser.friends = currentUser.friends.concat(person);
        await currentUser.save();
      } catch (error) {
        throw new GraphQLError(error.message, {
          invalidArgs: args,
        });
      }

      pubsub.publish(SUBSCRIPTION_EVENTS.PERSON_ADDED, { personAdded: person });
      return person;
    },
    editNumber: async (root, args) => {
      const person = await Person.findOne({ name: args.name });
      if (!person) return null;
      person.phone = args.phone;

      try {
        await person.save();
      } catch (error) {
        throw new GraphQLError(error.message, {
          invalidArgs: args,
        });
      }

      return person;
    },
    createUser: (root, args) => {
      const user = new User({ username: args.username });

      return user.save().catch((error) => {
        throw new GraphQLError(error.message, {
          invalidArgs: args,
        });
      });
    },
    login: async (root, args) => {
      const user = await User.findOne({ username: args.username });
      if (!user || args.password !== "1234") {
        throw new GraphQLError("wrong credentials");
      }
      const userForToken = {
        username: user.username,
        id: user._id,
      };
      return { value: jwt.sign(userForToken, process.env.JWT_SECRET) };
    },
    addAsFriend: async (root, args, { currentUser }) => {
      if (!currentUser) throw new GraphQLError("not authenticated");
      const person = await Person.findOne({ name: args.name });
      const nonFriendAlready = (person) =>
        !currentUser.friends.some((f) => f._id.equals(person._id));
      if (nonFriendAlready(person)) {
        console.log("amigo añadido");
        currentUser.friends = currentUser.friends.concat(person);
        await currentUser.save();
      }
      console.log("amigo ya existente");
      return currentUser;
    },
  },
  Person: {
    address: (root) => {
      return {
        street: root.street,
        city: root.city,
      };
    },
  },
  Subscription: {
    personAdded: {
      subscribe: () => pubsub.asyncIterator([SUBSCRIPTION_EVENTS.PERSON_ADDED]),
    },
  },
};

const schema = makeExecutableSchema({ typeDefs: typeDefinitions, resolvers });
const app = express();
const httpServer = createServer(app);
const wsServer = new WebSocketServer({
  server: httpServer,
  path: "/graphql",
});

const serverCleanup = useServer(
  {
    schema,
  },
  wsServer
);

const server = new ApolloServer({
  schema,
  plugins: [
    // Proper shutdown for the HTTP server.
    ApolloServerPluginDrainHttpServer({ httpServer }),

    // Proper shutdown for the WebSocket server.
    {
      async serverWillStart() {
        return {
          async drainServer() {
            await serverCleanup.dispose();
          },
        };
      },
    },
  ],
});

await server.start();

app.use(
  "/graphql",
  cors(),
  express.json(),
  expressMiddleware(server, {
    context: async ({ req }) => {
      const auth = req ? req.headers.authorization : null;
      if (auth && auth.toLowerCase().startsWith("bearer ")) {
        const decodedToken = jwt.verify(
          auth.substring(7),
          process.env.JWT_SECRET
        );
        const currentUser = await User.findById(decodedToken.id).populate(
          "friends"
        );
        return { currentUser };
      }
    },
  })
);

const PORT = 4000;
// Now that our HTTP server is fully set up, we can listen to it.
httpServer.listen(PORT, () => {
  console.log(`Server is now running on http://localhost:${PORT}/graphql`);
});

// const { url } = await startStandaloneServer(server, {
//   context: async ({ req }) => {
//     const auth = req ? req.headers.authorization : null;
//     if (auth && auth.toLowerCase().startsWith("bearer ")) {
//       const decodedToken = jwt.verify(
//         auth.substring(7),
//         process.env.JWT_SECRET
//       );
//       const currentUser = await User.findById(decodedToken.id).populate(
//         "friends"
//       );
//       return { currentUser };
//     }
//   },
// });
