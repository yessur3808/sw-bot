import requests
import json

def fetch_and_process_data(url):
    """Fetches data from a URL and processes it."""
    try:
        # 1. Fetch data using requests
        response = requests.get(url)
        response.raise_for_status() # Raise an exception for bad status codes (4xx or 5xx)
        data = response.json()

        print("--- Data Fetched Successfully ---")
        # Assuming the API returns a list of items, we'll process the first few keys/values.
        if isinstance(data, list):
            print(f"Successfully fetched a list of {len(data)} items.")
            for i, item in enumerate(data[:3]): # Print details for up to 3 items
                print(f"Item {i+1}: {item}")
        elif isinstance(data, dict):
            print("Successfully fetched data as a dictionary. Keys found:")
            for key, value in list(data.items())[:5]: # Print details for up to 5 keys
                print(f"- {key}: {value}")
        else:
            print("Data structure is neither a list nor a dictionary.")

    except requests.exceptions.RequestException as e:
        print(f"Error fetching data: {e}")
    except json.JSONDecodeError:
        print("Error decoding JSON response. The API might not be returning valid JSON.")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

if __name__ == "__main__":
    # Using a public placeholder API for demonstration (JSONPlaceholder)
    API_URL = "https://jsonplaceholder.typicode.com/posts/1"
    fetch_and_process_data(API_URL)
