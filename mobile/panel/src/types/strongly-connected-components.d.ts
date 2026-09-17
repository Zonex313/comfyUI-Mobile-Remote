declare module "strongly-connected-components" {
  interface StronglyConnectedComponents {
    components: number[][];
    adjacencyList: number[][];
  }

  function stronglyConnectedComponents(adjacencyList: number[][]): StronglyConnectedComponents;
  export = stronglyConnectedComponents;
}
